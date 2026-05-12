#include <jni.h>

#include <algorithm>
#include <array>
#include <climits>
#include <cstdint>
#include <exception>
#include <deque>
#include <limits>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#ifndef JAI_LLAMA_CPP_AVAILABLE
#define JAI_LLAMA_CPP_AVAILABLE 0
#endif

#if JAI_LLAMA_CPP_AVAILABLE
#include "llama.h"
#endif

namespace {

class JaiNativeError : public std::runtime_error {
 public:
  JaiNativeError(std::string code, std::string detail)
      : std::runtime_error(std::move(detail)), code_(std::move(code)) {}

  const std::string &code() const { return code_; }

 private:
  std::string code_;
};

void throwJavaException(JNIEnv *env, const std::string &code, const std::string &detail) {
  jclass exception_class = env->FindClass("java/lang/IllegalStateException");
  if (exception_class == nullptr) {
    return;
  }

  const std::string message = "JaiOnDeviceModel error [" + code + "]: " + detail;
  env->ThrowNew(exception_class, message.c_str());
}

void throwBackendMissing(JNIEnv *env, const char *operation, const char *model_path) {
  throwJavaException(
      env,
      "JAI_LLAMA_CPP_BACKEND_MISSING",
      std::string(operation) + " reached libjai_llama_runtime.so for model " +
          std::string(model_path == nullptr || model_path[0] == '\0' ? "<missing>" : model_path) +
          ", but this build was compiled without llama.cpp. Vendor llama.cpp at "
          "mobile/modules/jai-on-device-model/vendor/llama.cpp or "
          "mobile/modules/jai-on-device-model/android/src/main/cpp/llama.cpp, or pass "
          "-DJAI_LLAMA_CPP_DIR=/path/to/llama.cpp. The native module is local-only and never "
          "calls backend/OpenAI.");
}

std::string jstringToUtf8(JNIEnv *env, jstring value) {
  if (value == nullptr) {
    return "";
  }
  const char *chars = env->GetStringUTFChars(value, nullptr);
  if (chars == nullptr) {
    return "";
  }
  std::string out(chars);
  env->ReleaseStringUTFChars(value, chars);
  return out;
}

jstring emptyJavaString(JNIEnv *env) {
  const jchar empty[] = {0};
  return env->NewString(empty, 0);
}

jstring utf8BytesToJavaString(JNIEnv *env, const std::string &value) {
  if (value.empty()) {
    return emptyJavaString(env);
  }

  if (value.size() > static_cast<size_t>(std::numeric_limits<jsize>::max())) {
    throwJavaException(
        env,
        "JAI_LLAMA_CPP_JNI_STRING_TOO_LARGE",
        "Generated model output is too large to marshal into a Java String.");
    return nullptr;
  }

  jbyteArray bytes = env->NewByteArray(static_cast<jsize>(value.size()));
  if (bytes == nullptr) {
    return nullptr;
  }
  env->SetByteArrayRegion(
      bytes,
      0,
      static_cast<jsize>(value.size()),
      reinterpret_cast<const jbyte *>(value.data()));
  if (env->ExceptionCheck()) {
    env->DeleteLocalRef(bytes);
    return nullptr;
  }

  jclass standard_charsets_class = env->FindClass("java/nio/charset/StandardCharsets");
  if (standard_charsets_class == nullptr) {
    env->DeleteLocalRef(bytes);
    return nullptr;
  }

  jfieldID utf8_field = env->GetStaticFieldID(
      standard_charsets_class,
      "UTF_8",
      "Ljava/nio/charset/Charset;");
  if (utf8_field == nullptr) {
    env->DeleteLocalRef(standard_charsets_class);
    env->DeleteLocalRef(bytes);
    return nullptr;
  }

  jobject utf8_charset = env->GetStaticObjectField(standard_charsets_class, utf8_field);
  if (utf8_charset == nullptr) {
    env->DeleteLocalRef(standard_charsets_class);
    env->DeleteLocalRef(bytes);
    return nullptr;
  }

  jclass string_class = env->FindClass("java/lang/String");
  if (string_class == nullptr) {
    env->DeleteLocalRef(utf8_charset);
    env->DeleteLocalRef(standard_charsets_class);
    env->DeleteLocalRef(bytes);
    return nullptr;
  }

  jmethodID string_ctor = env->GetMethodID(
      string_class,
      "<init>",
      "([BLjava/nio/charset/Charset;)V");
  if (string_ctor == nullptr) {
    env->DeleteLocalRef(string_class);
    env->DeleteLocalRef(utf8_charset);
    env->DeleteLocalRef(standard_charsets_class);
    env->DeleteLocalRef(bytes);
    return nullptr;
  }

  jobject result = env->NewObject(string_class, string_ctor, bytes, utf8_charset);
  env->DeleteLocalRef(string_class);
  env->DeleteLocalRef(utf8_charset);
  env->DeleteLocalRef(standard_charsets_class);
  env->DeleteLocalRef(bytes);

  if (result == nullptr) {
    return nullptr;
  }
  return static_cast<jstring>(result);
}

std::string normalizeModelPath(std::string path) {
  constexpr const char *prefix = "file://";
  if (path.rfind(prefix, 0) == 0) {
    return path.substr(std::char_traits<char>::length(prefix));
  }
  return path;
}

#if JAI_LLAMA_CPP_AVAILABLE

struct LlamaModelDeleter {
  void operator()(llama_model *model) const {
    if (model != nullptr) {
      llama_model_free(model);
    }
  }
};

struct LlamaContextDeleter {
  void operator()(llama_context *ctx) const {
    if (ctx != nullptr) {
      llama_free(ctx);
    }
  }
};

struct LlamaBatchDeleter {
  void operator()(llama_batch *batch) const {
    if (batch != nullptr) {
      llama_batch_free(*batch);
      delete batch;
    }
  }
};

struct LlamaSamplerDeleter {
  void operator()(llama_sampler *sampler) const {
    if (sampler != nullptr) {
      llama_sampler_free(sampler);
    }
  }
};

using LlamaModelPtr = std::shared_ptr<llama_model>;
using LlamaContextPtr = std::unique_ptr<llama_context, LlamaContextDeleter>;
using LlamaBatchPtr = std::unique_ptr<llama_batch, LlamaBatchDeleter>;
using LlamaSamplerPtr = std::unique_ptr<llama_sampler, LlamaSamplerDeleter>;

std::once_flag g_backend_once;
std::mutex g_model_cache_mutex;
constexpr size_t kMaxStrongCachedModels = 1;
std::unordered_map<std::string, LlamaModelPtr> g_model_cache;
std::deque<std::string> g_model_cache_lru;

void ensureBackendInitialized() {
  std::call_once(g_backend_once, []() { llama_backend_init(); });
}

void clearModelCache() {
  std::lock_guard<std::mutex> lock(g_model_cache_mutex);
  g_model_cache.clear();
  g_model_cache_lru.clear();
}

int clampThreads(jint threads) {
  const int requested = static_cast<int>(threads);
  if (requested <= 0) {
    return 1;
  }
  return std::max(1, std::min(requested, 8));
}

uint32_t clampContextSize(jint context_size) {
  const int requested = static_cast<int>(context_size);
  if (requested <= 0) {
    return 4096;
  }
  return static_cast<uint32_t>(std::max(512, requested));
}

LlamaModelPtr loadOrGetModel(const std::string &model_path) {
  if (model_path.empty()) {
    throw JaiNativeError("JAI_MODEL_PATH_MISSING", "Cannot load llama.cpp model because modelPath is empty.");
  }

  ensureBackendInitialized();

  {
    std::lock_guard<std::mutex> lock(g_model_cache_mutex);
    auto it = g_model_cache.find(model_path);
    if (it != g_model_cache.end()) {
      g_model_cache_lru.erase(
          std::remove(g_model_cache_lru.begin(), g_model_cache_lru.end(), model_path),
          g_model_cache_lru.end());
      g_model_cache_lru.push_back(model_path);
      return it->second;
    }
  }

  llama_model_params model_params = llama_model_default_params();
  model_params.use_mmap = llama_supports_mmap();
  model_params.use_mlock = false;
  model_params.check_tensors = false;
  model_params.n_gpu_layers = 0;

  llama_model *raw_model = llama_model_load_from_file(model_path.c_str(), model_params);
  if (raw_model == nullptr) {
    throw JaiNativeError(
        "JAI_LLAMA_CPP_MODEL_LOAD_FAILED",
        "llama.cpp could not load GGUF model at " + model_path +
            ". Verify that the downloaded file exists, is non-empty, matches its expected byte size and SHA-256 checksum, and is a valid GGUF file.");
  }

  LlamaModelPtr model(raw_model, LlamaModelDeleter{});
  {
    std::lock_guard<std::mutex> lock(g_model_cache_mutex);
    g_model_cache[model_path] = model;
    g_model_cache_lru.erase(
        std::remove(g_model_cache_lru.begin(), g_model_cache_lru.end(), model_path),
        g_model_cache_lru.end());
    g_model_cache_lru.push_back(model_path);
    while (g_model_cache_lru.size() > kMaxStrongCachedModels) {
      const std::string evicted = g_model_cache_lru.front();
      g_model_cache_lru.pop_front();
      if (evicted != model_path) {
        g_model_cache.erase(evicted);
      }
    }
  }
  return model;
}

LlamaContextPtr createContext(const LlamaModelPtr &model, uint32_t context_size, int threads, bool embeddings) {
  llama_context_params ctx_params = llama_context_default_params();
  ctx_params.n_ctx = context_size;
  ctx_params.n_batch = std::min<uint32_t>(context_size, 512);
  ctx_params.n_ubatch = std::min<uint32_t>(ctx_params.n_batch, 512);
  ctx_params.n_seq_max = 1;
  ctx_params.n_threads = threads;
  ctx_params.n_threads_batch = threads;
  ctx_params.embeddings = embeddings;
  ctx_params.no_perf = true;

  if (embeddings) {
    ctx_params.pooling_type = LLAMA_POOLING_TYPE_MEAN;
    ctx_params.attention_type = LLAMA_ATTENTION_TYPE_NON_CAUSAL;
  }

  llama_context *raw_ctx = llama_init_from_model(model.get(), ctx_params);
  if (raw_ctx == nullptr) {
    throw JaiNativeError(
        "JAI_LLAMA_CPP_CONTEXT_CREATE_FAILED",
        "llama.cpp could not create a context for the loaded GGUF model. Try reducing contextSize or using a smaller quantized model.");
  }
  llama_set_n_threads(raw_ctx, threads, threads);
  return LlamaContextPtr(raw_ctx);
}

std::vector<llama_token> tokenize(const llama_model *model, const std::string &text, bool add_special, bool parse_special) {
  const llama_vocab *vocab = llama_model_get_vocab(model);
  if (vocab == nullptr) {
    throw JaiNativeError("JAI_LLAMA_CPP_TOKENIZER_MISSING", "The loaded GGUF model does not expose a llama.cpp vocabulary.");
  }

  const int32_t text_len = static_cast<int32_t>(std::min<size_t>(text.size(), static_cast<size_t>(INT32_MAX)));
  int32_t count = llama_tokenize(vocab, text.c_str(), text_len, nullptr, 0, add_special, parse_special);
  if (count == INT32_MIN) {
    throw JaiNativeError("JAI_LLAMA_CPP_TOKENIZE_FAILED", "Input text is too large to tokenize.");
  }
  if (count < 0) {
    count = -count;
  }
  if (count == 0) {
    return {};
  }

  std::vector<llama_token> tokens(static_cast<size_t>(count));
  int32_t actual = llama_tokenize(vocab, text.c_str(), text_len, tokens.data(), count, add_special, parse_special);
  if (actual < 0) {
    throw JaiNativeError("JAI_LLAMA_CPP_TOKENIZE_FAILED", "llama.cpp tokenization failed even after allocating the requested token buffer.");
  }
  tokens.resize(static_cast<size_t>(actual));
  return tokens;
}

std::string tokenToPiece(const llama_model *model, llama_token token) {
  const llama_vocab *vocab = llama_model_get_vocab(model);
  std::array<char, 256> stack_buffer{};
  int32_t written = llama_token_to_piece(vocab, token, stack_buffer.data(), static_cast<int32_t>(stack_buffer.size()), 0, false);
  if (written < 0) {
    const int32_t needed = -written;
    std::vector<char> heap_buffer(static_cast<size_t>(needed));
    written = llama_token_to_piece(vocab, token, heap_buffer.data(), needed, 0, false);
    if (written > 0) {
      return std::string(heap_buffer.data(), static_cast<size_t>(written));
    }
    return "";
  }
  if (written == 0) {
    return "";
  }
  return std::string(stack_buffer.data(), static_cast<size_t>(written));
}

LlamaBatchPtr makeBatch(const std::vector<llama_token> &tokens, size_t offset, size_t count, llama_pos start_pos, bool logits_last_only) {
  auto batch = LlamaBatchPtr(new llama_batch(llama_batch_init(static_cast<int32_t>(count), 0, 1)));
  batch->n_tokens = 0;
  for (size_t i = 0; i < count; ++i) {
    const int32_t index = batch->n_tokens++;
    batch->token[index] = tokens[offset + i];
    batch->pos[index] = start_pos + static_cast<llama_pos>(i);
    batch->n_seq_id[index] = 1;
    batch->seq_id[index][0] = 0;
    batch->logits[index] = logits_last_only && i + 1 == count ? 1 : 0;
  }
  return batch;
}

std::string decodeFailureDetail(
    const std::string &operation,
    int32_t status,
    llama_context *ctx,
    const llama_batch &batch,
    size_t input_token_count) {
  return "llama.cpp failed while decoding " + operation +
      ". Status=" + std::to_string(status) +
      ", tokens=" + std::to_string(input_token_count) +
      ", batch.n_tokens=" + std::to_string(batch.n_tokens) +
      ", n_ctx=" + std::to_string(llama_n_ctx(ctx)) +
      ", n_batch=" + std::to_string(llama_n_batch(ctx)) + ".";
}

void decodeTokens(llama_context *ctx, const std::vector<llama_token> &tokens, bool logits_on_last_token) {
  if (tokens.empty()) {
    throw JaiNativeError("JAI_LLAMA_CPP_EMPTY_PROMPT", "Cannot run llama.cpp decode with an empty token list.");
  }

  const uint32_t n_batch = std::max<uint32_t>(1, std::min<uint32_t>(llama_n_batch(ctx), 512));
  llama_pos pos = 0;
  size_t offset = 0;
  while (offset < tokens.size()) {
    const size_t count = std::min<size_t>(tokens.size() - offset, n_batch);
    const bool is_last = offset + count >= tokens.size();
    auto batch = makeBatch(tokens, offset, count, pos, logits_on_last_token && is_last);
    const int32_t status = llama_decode(ctx, *batch);
    if (status != 0) {
      throw JaiNativeError(
          "JAI_LLAMA_CPP_DECODE_FAILED",
          decodeFailureDetail("prompt/input tokens", status, ctx, *batch, tokens.size()));
    }
    pos += static_cast<llama_pos>(count);
    offset += count;
  }
}

void decodeSingleToken(llama_context *ctx, llama_token token, llama_pos pos) {
  std::vector<llama_token> one = {token};
  auto batch = makeBatch(one, 0, 1, pos, true);
  const int32_t status = llama_decode(ctx, *batch);
  if (status != 0) {
    throw JaiNativeError(
        "JAI_LLAMA_CPP_DECODE_FAILED",
        decodeFailureDetail("a generated token", status, ctx, *batch, 1));
  }
}

LlamaSamplerPtr createSampler(double temperature) {
  llama_sampler_chain_params sampler_params = llama_sampler_chain_default_params();
  sampler_params.no_perf = true;
  llama_sampler *chain = llama_sampler_chain_init(sampler_params);
  if (chain == nullptr) {
    throw JaiNativeError("JAI_LLAMA_CPP_SAMPLER_CREATE_FAILED", "llama.cpp could not create a sampler chain.");
  }

  if (temperature <= 0.0) {
    llama_sampler_chain_add(chain, llama_sampler_init_greedy());
  } else {
    llama_sampler_chain_add(chain, llama_sampler_init_top_k(40));
    llama_sampler_chain_add(chain, llama_sampler_init_top_p(0.95f, 1));
    llama_sampler_chain_add(chain, llama_sampler_init_min_p(0.05f, 1));
    llama_sampler_chain_add(chain, llama_sampler_init_temp(static_cast<float>(temperature)));
    llama_sampler_chain_add(chain, llama_sampler_init_dist(LLAMA_DEFAULT_SEED));
  }

  return LlamaSamplerPtr(chain);
}

std::string completeChatNative(
    const std::string &raw_model_path,
    const std::string &prompt,
    jint context_size,
    jint threads,
    jdouble temperature,
    jint max_tokens) {
  const std::string model_path = normalizeModelPath(raw_model_path);
  auto model = loadOrGetModel(model_path);
  const uint32_t n_ctx = clampContextSize(context_size);
  auto ctx = createContext(model, n_ctx, clampThreads(threads), false);

  std::vector<llama_token> prompt_tokens = tokenize(model.get(), prompt, true, true);
  if (prompt_tokens.empty()) {
    throw JaiNativeError("JAI_LLAMA_CPP_EMPTY_PROMPT", "The chat prompt produced zero tokens.");
  }

  const int requested_max_tokens = std::max(1, static_cast<int>(max_tokens));
  const size_t max_prompt_tokens = n_ctx > 8 ? static_cast<size_t>(n_ctx - 8) : static_cast<size_t>(n_ctx - 1);
  if (prompt_tokens.size() > max_prompt_tokens) {
    prompt_tokens.erase(prompt_tokens.begin(), prompt_tokens.end() - static_cast<std::ptrdiff_t>(max_prompt_tokens));
  }

  decodeTokens(ctx.get(), prompt_tokens, true);

  const llama_vocab *vocab = llama_model_get_vocab(model.get());
  auto sampler = createSampler(static_cast<double>(temperature));
  std::string generated;
  generated.reserve(static_cast<size_t>(requested_max_tokens) * 4);

  llama_pos next_pos = static_cast<llama_pos>(prompt_tokens.size());
  for (int i = 0; i < requested_max_tokens && static_cast<uint32_t>(next_pos) + 1 < n_ctx; ++i) {
    llama_token token = llama_sampler_sample(sampler.get(), ctx.get(), -1);
    if (token == LLAMA_TOKEN_NULL || llama_vocab_is_eog(vocab, token)) {
      break;
    }

    llama_sampler_accept(sampler.get(), token);
    generated += tokenToPiece(model.get(), token);
    decodeSingleToken(ctx.get(), token, next_pos);
    ++next_pos;
  }

  return generated;
}

std::vector<float> embedTextNative(
    const std::string &raw_model_path,
    const std::string &text,
    jint context_size,
    jint threads) {
  const std::string model_path = normalizeModelPath(raw_model_path);
  auto model = loadOrGetModel(model_path);
  const uint32_t n_ctx = clampContextSize(context_size);
  auto ctx = createContext(model, n_ctx, clampThreads(threads), true);

  std::vector<llama_token> tokens = tokenize(model.get(), text, true, false);
  if (tokens.empty()) {
    throw JaiNativeError("JAI_LLAMA_CPP_EMPTY_EMBEDDING_INPUT", "The embedding input produced zero tokens.");
  }
  const uint32_t max_embedding_tokens = std::min<uint32_t>(n_ctx, llama_n_batch(ctx.get()));
  if (tokens.size() > max_embedding_tokens) {
    tokens.resize(static_cast<size_t>(max_embedding_tokens));
  }

  auto batch = LlamaBatchPtr(new llama_batch(llama_batch_init(static_cast<int32_t>(tokens.size()), 0, 1)));
  batch->n_tokens = 0;
  for (size_t i = 0; i < tokens.size(); ++i) {
    const int32_t index = batch->n_tokens++;
    batch->token[index] = tokens[i];
    batch->pos[index] = static_cast<llama_pos>(i);
    batch->n_seq_id[index] = 1;
    batch->seq_id[index][0] = 0;
    batch->logits[index] = 1;
  }

  const int32_t status = llama_decode(ctx.get(), *batch);
  if (status != 0) {
    throw JaiNativeError(
        "JAI_LLAMA_CPP_EMBEDDING_DECODE_FAILED",
        decodeFailureDetail("embedding input", status, ctx.get(), *batch, tokens.size()));
  }

  float *embedding = llama_get_embeddings_seq(ctx.get(), 0);
  int32_t dimension = llama_model_n_embd(model.get());
#if defined(LLAMA_API)
  const int32_t out_dimension = llama_model_n_embd_out(model.get());
  if (out_dimension > 0) {
    dimension = out_dimension;
  }
#endif
  if (embedding == nullptr) {
    embedding = llama_get_embeddings_ith(ctx.get(), -1);
  }
  if (embedding == nullptr || dimension <= 0) {
    throw JaiNativeError(
        "JAI_LLAMA_CPP_EMBEDDING_EXTRACT_FAILED",
        "llama.cpp did not return embeddings for this model/input. Ensure the Qwen embedding GGUF supports embeddings and the context was created with embeddings enabled.");
  }

  return std::vector<float>(embedding, embedding + dimension);
}

#endif // JAI_LLAMA_CPP_AVAILABLE

} // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_com_harishajahan_jai_ondevice_JaiLlamaCppBinding_nativeCompleteChat(
    JNIEnv *env,
    jobject /* thiz */,
    jstring model_path,
    jstring prompt,
    jint context_size,
    jint threads,
    jdouble temperature,
    jint max_tokens) {
  const std::string model_path_utf8 = jstringToUtf8(env, model_path);
  const std::string prompt_utf8 = jstringToUtf8(env, prompt);

#if JAI_LLAMA_CPP_AVAILABLE
  try {
    const std::string generated = completeChatNative(
        model_path_utf8,
        prompt_utf8,
        context_size,
        threads,
        temperature,
        max_tokens);
    return utf8BytesToJavaString(env, generated);
  } catch (const JaiNativeError &error) {
    throwJavaException(env, error.code(), error.what());
    return nullptr;
  } catch (const std::exception &error) {
    throwJavaException(env, "JAI_LLAMA_CPP_INFERENCE_FAILED", error.what());
    return nullptr;
  }
#else
  (void)prompt_utf8;
  (void)context_size;
  (void)threads;
  (void)temperature;
  (void)max_tokens;
  throwBackendMissing(env, "nativeCompleteChat", model_path_utf8.c_str());
  return nullptr;
#endif
}

extern "C" JNIEXPORT jfloatArray JNICALL
Java_com_harishajahan_jai_ondevice_JaiLlamaCppBinding_nativeEmbedText(
    JNIEnv *env,
    jobject /* thiz */,
    jstring model_path,
    jstring text,
    jint context_size,
    jint threads) {
  const std::string model_path_utf8 = jstringToUtf8(env, model_path);
  const std::string text_utf8 = jstringToUtf8(env, text);

#if JAI_LLAMA_CPP_AVAILABLE
  try {
    const std::vector<float> embedding = embedTextNative(model_path_utf8, text_utf8, context_size, threads);
    jfloatArray array = env->NewFloatArray(static_cast<jsize>(embedding.size()));
    if (array == nullptr) {
      throwJavaException(env, "JAI_LLAMA_CPP_JNI_ALLOCATION_FAILED", "Could not allocate Java float array for embedding output.");
      return nullptr;
    }
    env->SetFloatArrayRegion(array, 0, static_cast<jsize>(embedding.size()), embedding.data());
    return array;
  } catch (const JaiNativeError &error) {
    throwJavaException(env, error.code(), error.what());
    return nullptr;
  } catch (const std::exception &error) {
    throwJavaException(env, "JAI_LLAMA_CPP_EMBEDDING_FAILED", error.what());
    return nullptr;
  }
#else
  (void)text_utf8;
  (void)context_size;
  (void)threads;
  throwBackendMissing(env, "nativeEmbedText", model_path_utf8.c_str());
  return nullptr;
#endif
}

extern "C" JNIEXPORT void JNICALL
Java_com_harishajahan_jai_ondevice_JaiLlamaCppBinding_nativeReleaseCachedModels(
    JNIEnv *env,
    jobject /* thiz */) {
#if JAI_LLAMA_CPP_AVAILABLE
  try {
    clearModelCache();
  } catch (const std::exception &error) {
    throwJavaException(env, "JAI_LLAMA_CPP_CACHE_RELEASE_FAILED", error.what());
  }
#else
  (void)env;
#endif
}
