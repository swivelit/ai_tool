#import "JaiLlamaCppBridge.h"

#include <algorithm>
#include <array>
#include <climits>
#include <cstdint>
#include <exception>
#include <deque>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#ifndef JAI_LLAMA_CPP_AVAILABLE
#define JAI_LLAMA_CPP_AVAILABLE 0
#endif

#if JAI_LLAMA_CPP_AVAILABLE
#include "llama.h"
#endif

static NSString *const JaiLlamaCppBridgeErrorDomain = @"JaiOnDeviceModel";

namespace {

std::mutex gCancelledRequestsMutex;
std::unordered_set<std::string> gCancelledRequests;

bool isRequestCancelled(const std::string &requestId) {
  if (requestId.empty()) {
    return false;
  }
  std::lock_guard<std::mutex> lock(gCancelledRequestsMutex);
  return gCancelledRequests.find(requestId) != gCancelledRequests.end();
}

void cancelRequestId(const std::string &requestId) {
  if (requestId.empty()) {
    return;
  }
  std::lock_guard<std::mutex> lock(gCancelledRequestsMutex);
  gCancelledRequests.insert(requestId);
}

void clearCancelledRequestId(const std::string &requestId) {
  if (requestId.empty()) {
    return;
  }
  std::lock_guard<std::mutex> lock(gCancelledRequestsMutex);
  gCancelledRequests.erase(requestId);
}

class JaiNativeError : public std::runtime_error {
 public:
  JaiNativeError(std::string code, std::string detail)
      : std::runtime_error(std::move(detail)), code_(std::move(code)) {}

  const std::string &code() const { return code_; }

 private:
  std::string code_;
};

NSError *makeNSError(NSString *code, NSString *detail) {
  NSString *message = [NSString stringWithFormat:@"JaiOnDeviceModel error [%@]: %@", code, detail];
  return [NSError errorWithDomain:JaiLlamaCppBridgeErrorDomain
                             code:1001
                         userInfo:@{
                           NSLocalizedDescriptionKey: message,
                           @"code": code,
                         }];
}

NSError *makeNSError(const std::string &code, const std::string &detail) {
  return makeNSError(
      [NSString stringWithUTF8String:code.c_str()],
      [NSString stringWithUTF8String:detail.c_str()]);
}

void assignError(NSError **error, NSError *value) {
  if (error != nil) {
    *error = value;
  }
}

NSError *missingBackendError(NSString *operation, NSString *modelPath) {
  NSString *path = modelPath.length > 0 ? modelPath : @"<missing>";
  NSString *detail = [NSString stringWithFormat:
    @"%@ reached the Objective-C++ bridge for model %@, but this pod was compiled without llama.cpp. Vendor llama.cpp at mobile/modules/jai-on-device-model/vendor/llama.cpp or link a prebuilt llama.cpp static library in JaiOnDeviceModel.podspec. The native module is local-only and never calls backend/OpenAI.",
    operation,
    path];
  return makeNSError(@"JAI_LLAMA_CPP_BACKEND_MISSING", detail);
}

std::string stringFromNSString(NSString *value) {
  if (value == nil) {
    return "";
  }
  const char *utf8 = [value UTF8String];
  return utf8 == nullptr ? std::string() : std::string(utf8);
}

std::string normalizeModelPath(std::string path) {
  constexpr const char *prefix = "file://";
  if (path.rfind(prefix, 0) == 0) {
    return path.substr(std::char_traits<char>::length(prefix));
  }
  return path;
}

NSString *stringFromUtf8(const std::string &value) {
  NSString *text = [[NSString alloc] initWithBytes:value.data()
                                            length:value.size()
                                          encoding:NSUTF8StringEncoding];
  return text ?: @"";
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
constexpr size_t kMaxStrongCachedModels = 2;
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

int clampThreads(NSInteger threads) {
  const int requested = static_cast<int>(threads);
  if (requested <= 0) {
    return 1;
  }
  return std::max(1, std::min(requested, 8));
}

uint32_t clampContextSize(NSInteger contextSize) {
  const int requested = static_cast<int>(contextSize);
  if (requested <= 0) {
    return 4096;
  }
  return static_cast<uint32_t>(std::max(512, requested));
}

LlamaModelPtr loadOrGetModel(const std::string &modelPath) {
  if (modelPath.empty()) {
    throw JaiNativeError("JAI_MODEL_PATH_MISSING", "Cannot load llama.cpp model because modelPath is empty.");
  }

  ensureBackendInitialized();

  {
    std::lock_guard<std::mutex> lock(g_model_cache_mutex);
    auto it = g_model_cache.find(modelPath);
    if (it != g_model_cache.end()) {
      g_model_cache_lru.erase(
          std::remove(g_model_cache_lru.begin(), g_model_cache_lru.end(), modelPath),
          g_model_cache_lru.end());
      g_model_cache_lru.push_back(modelPath);
      return it->second;
    }
  }

  llama_model_params modelParams = llama_model_default_params();
  modelParams.use_mmap = llama_supports_mmap();
  modelParams.use_mlock = false;
  modelParams.check_tensors = false;
  modelParams.n_gpu_layers = 0;

  llama_model *rawModel = llama_model_load_from_file(modelPath.c_str(), modelParams);
  if (rawModel == nullptr) {
    throw JaiNativeError(
        "JAI_LLAMA_CPP_MODEL_LOAD_FAILED",
        "llama.cpp could not load GGUF model at " + modelPath +
            ". Verify that the downloaded file exists, is non-empty, matches its expected byte size and SHA-256 checksum, and is a valid GGUF file.");
  }

  LlamaModelPtr model(rawModel, LlamaModelDeleter{});
  {
    std::lock_guard<std::mutex> lock(g_model_cache_mutex);
    g_model_cache[modelPath] = model;
    g_model_cache_lru.erase(
        std::remove(g_model_cache_lru.begin(), g_model_cache_lru.end(), modelPath),
        g_model_cache_lru.end());
    g_model_cache_lru.push_back(modelPath);
    while (g_model_cache_lru.size() > kMaxStrongCachedModels) {
      const std::string evicted = g_model_cache_lru.front();
      g_model_cache_lru.pop_front();
      if (evicted != modelPath) {
        g_model_cache.erase(evicted);
      }
    }
  }
  return model;
}

LlamaContextPtr createContext(const LlamaModelPtr &model, uint32_t contextSize, int threads, bool embeddings) {
  llama_context_params ctxParams = llama_context_default_params();
  ctxParams.n_ctx = contextSize;
  ctxParams.n_batch = std::min<uint32_t>(contextSize, 512);
  ctxParams.n_ubatch = std::min<uint32_t>(ctxParams.n_batch, 512);
  ctxParams.n_seq_max = 1;
  ctxParams.n_threads = threads;
  ctxParams.n_threads_batch = threads;
  ctxParams.embeddings = embeddings;
  ctxParams.no_perf = true;

  if (embeddings) {
    ctxParams.pooling_type = LLAMA_POOLING_TYPE_MEAN;
    ctxParams.attention_type = LLAMA_ATTENTION_TYPE_NON_CAUSAL;
  }

  llama_context *rawCtx = llama_init_from_model(model.get(), ctxParams);
  if (rawCtx == nullptr) {
    throw JaiNativeError(
        "JAI_LLAMA_CPP_CONTEXT_CREATE_FAILED",
        "llama.cpp could not create a context for the loaded GGUF model. Try reducing contextSize or using a smaller quantized model.");
  }
  llama_set_n_threads(rawCtx, threads, threads);
  return LlamaContextPtr(rawCtx);
}

std::vector<llama_token> tokenize(const llama_model *model, const std::string &text, bool addSpecial, bool parseSpecial) {
  const llama_vocab *vocab = llama_model_get_vocab(model);
  if (vocab == nullptr) {
    throw JaiNativeError("JAI_LLAMA_CPP_TOKENIZER_MISSING", "The loaded GGUF model does not expose a llama.cpp vocabulary.");
  }

  const int32_t textLen = static_cast<int32_t>(std::min<size_t>(text.size(), static_cast<size_t>(INT32_MAX)));
  int32_t count = llama_tokenize(vocab, text.c_str(), textLen, nullptr, 0, addSpecial, parseSpecial);
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
  int32_t actual = llama_tokenize(vocab, text.c_str(), textLen, tokens.data(), count, addSpecial, parseSpecial);
  if (actual < 0) {
    throw JaiNativeError("JAI_LLAMA_CPP_TOKENIZE_FAILED", "llama.cpp tokenization failed even after allocating the requested token buffer.");
  }
  tokens.resize(static_cast<size_t>(actual));
  return tokens;
}

std::string tokenToPiece(const llama_model *model, llama_token token) {
  const llama_vocab *vocab = llama_model_get_vocab(model);
  std::array<char, 256> stackBuffer{};
  int32_t written = llama_token_to_piece(vocab, token, stackBuffer.data(), static_cast<int32_t>(stackBuffer.size()), 0, false);
  if (written < 0) {
    const int32_t needed = -written;
    std::vector<char> heapBuffer(static_cast<size_t>(needed));
    written = llama_token_to_piece(vocab, token, heapBuffer.data(), needed, 0, false);
    if (written > 0) {
      return std::string(heapBuffer.data(), static_cast<size_t>(written));
    }
    return "";
  }
  if (written == 0) {
    return "";
  }
  return std::string(stackBuffer.data(), static_cast<size_t>(written));
}

LlamaBatchPtr makeBatch(const std::vector<llama_token> &tokens, size_t offset, size_t count, llama_pos startPos, bool logitsLastOnly) {
  auto batch = LlamaBatchPtr(new llama_batch(llama_batch_init(static_cast<int32_t>(count), 0, 1)));
  batch->n_tokens = 0;
  for (size_t i = 0; i < count; ++i) {
    const int32_t index = batch->n_tokens++;
    batch->token[index] = tokens[offset + i];
    batch->pos[index] = startPos + static_cast<llama_pos>(i);
    batch->n_seq_id[index] = 1;
    batch->seq_id[index][0] = 0;
    batch->logits[index] = logitsLastOnly && i + 1 == count ? 1 : 0;
  }
  return batch;
}

std::string decodeFailureDetail(
    const std::string &operation,
    int32_t status,
    llama_context *ctx,
    const llama_batch &batch,
    size_t inputTokenCount) {
  return "llama.cpp failed while decoding " + operation +
      ". Status=" + std::to_string(status) +
      ", tokens=" + std::to_string(inputTokenCount) +
      ", batch.n_tokens=" + std::to_string(batch.n_tokens) +
      ", n_ctx=" + std::to_string(llama_n_ctx(ctx)) +
      ", n_batch=" + std::to_string(llama_n_batch(ctx)) + ".";
}

bool decodeTokens(
    llama_context *ctx,
    const std::vector<llama_token> &tokens,
    bool logitsOnLastToken,
    const std::string &requestId) {
  if (tokens.empty()) {
    throw JaiNativeError("JAI_LLAMA_CPP_EMPTY_PROMPT", "Cannot run llama.cpp decode with an empty token list.");
  }

  const uint32_t nBatch = std::max<uint32_t>(1, std::min<uint32_t>(llama_n_batch(ctx), 512));
  llama_pos pos = 0;
  size_t offset = 0;
  while (offset < tokens.size()) {
    if (isRequestCancelled(requestId)) {
      return false;
    }
    const size_t count = std::min<size_t>(tokens.size() - offset, nBatch);
    const bool isLast = offset + count >= tokens.size();
    auto batch = makeBatch(tokens, offset, count, pos, logitsOnLastToken && isLast);
    const int32_t status = llama_decode(ctx, *batch);
    if (status != 0) {
      throw JaiNativeError(
          "JAI_LLAMA_CPP_DECODE_FAILED",
          decodeFailureDetail("prompt/input tokens", status, ctx, *batch, tokens.size()));
    }
    if (isRequestCancelled(requestId)) {
      return false;
    }
    pos += static_cast<llama_pos>(count);
    offset += count;
  }
  return true;
}

bool decodeSingleToken(llama_context *ctx, llama_token token, llama_pos pos, const std::string &requestId) {
  if (isRequestCancelled(requestId)) {
    return false;
  }
  std::vector<llama_token> one = {token};
  auto batch = makeBatch(one, 0, 1, pos, true);
  const int32_t status = llama_decode(ctx, *batch);
  if (status != 0) {
    throw JaiNativeError(
        "JAI_LLAMA_CPP_DECODE_FAILED",
        decodeFailureDetail("a generated token", status, ctx, *batch, 1));
  }
  return !isRequestCancelled(requestId);
}

LlamaSamplerPtr createSampler(double temperature) {
  llama_sampler_chain_params samplerParams = llama_sampler_chain_default_params();
  samplerParams.no_perf = true;
  llama_sampler *chain = llama_sampler_chain_init(samplerParams);
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
    const std::string &rawModelPath,
    const std::string &prompt,
    NSInteger contextSize,
    NSInteger threads,
    double temperature,
    NSInteger maxTokens,
    const std::string &requestId) {
  const std::string modelPath = normalizeModelPath(rawModelPath);
  auto model = loadOrGetModel(modelPath);
  const uint32_t nCtx = clampContextSize(contextSize);
  auto ctx = createContext(model, nCtx, clampThreads(threads), false);

  std::vector<llama_token> promptTokens = tokenize(model.get(), prompt, true, true);
  if (promptTokens.empty()) {
    throw JaiNativeError("JAI_LLAMA_CPP_EMPTY_PROMPT", "The chat prompt produced zero tokens.");
  }

  const int requestedMaxTokens = std::max(1, static_cast<int>(maxTokens));
  const size_t maxPromptTokens = nCtx > 8 ? static_cast<size_t>(nCtx - 8) : static_cast<size_t>(nCtx - 1);
  if (promptTokens.size() > maxPromptTokens) {
    promptTokens.erase(promptTokens.begin(), promptTokens.end() - static_cast<std::ptrdiff_t>(maxPromptTokens));
  }

  if (!decodeTokens(ctx.get(), promptTokens, true, requestId)) {
    clearCancelledRequestId(requestId);
    return "";
  }

  const llama_vocab *vocab = llama_model_get_vocab(model.get());
  auto sampler = createSampler(temperature);
  std::string generated;
  generated.reserve(static_cast<size_t>(requestedMaxTokens) * 4);

  llama_pos nextPos = static_cast<llama_pos>(promptTokens.size());
  for (int i = 0; i < requestedMaxTokens && static_cast<uint32_t>(nextPos) + 1 < nCtx; ++i) {
    if (isRequestCancelled(requestId)) {
      clearCancelledRequestId(requestId);
      break;
    }
    llama_token token = llama_sampler_sample(sampler.get(), ctx.get(), -1);
    if (token == LLAMA_TOKEN_NULL || llama_vocab_is_eog(vocab, token)) {
      break;
    }

    llama_sampler_accept(sampler.get(), token);
    generated += tokenToPiece(model.get(), token);
    if (isRequestCancelled(requestId)) {
      clearCancelledRequestId(requestId);
      break;
    }
    if (!decodeSingleToken(ctx.get(), token, nextPos, requestId)) {
      clearCancelledRequestId(requestId);
      break;
    }
    ++nextPos;
  }

  clearCancelledRequestId(requestId);
  return generated;
}

std::vector<float> embedTextNative(
    const std::string &rawModelPath,
    const std::string &text,
    NSInteger contextSize,
    NSInteger threads) {
  const std::string modelPath = normalizeModelPath(rawModelPath);
  auto model = loadOrGetModel(modelPath);
  const uint32_t nCtx = clampContextSize(contextSize);
  auto ctx = createContext(model, nCtx, clampThreads(threads), true);

  std::vector<llama_token> tokens = tokenize(model.get(), text, true, false);
  if (tokens.empty()) {
    throw JaiNativeError("JAI_LLAMA_CPP_EMPTY_EMBEDDING_INPUT", "The embedding input produced zero tokens.");
  }
  const uint32_t maxEmbeddingTokens = std::min<uint32_t>(nCtx, llama_n_batch(ctx.get()));
  if (tokens.size() > maxEmbeddingTokens) {
    tokens.resize(static_cast<size_t>(maxEmbeddingTokens));
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
  const int32_t outDimension = llama_model_n_embd_out(model.get());
  if (outDimension > 0) {
    dimension = outDimension;
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

@implementation JaiLlamaCppBridge

+ (void)releaseCachedModels {
#if JAI_LLAMA_CPP_AVAILABLE
  clearModelCache();
#endif
}

+ (void)cancelRequest:(NSString *)requestId {
  cancelRequestId(stringFromNSString(requestId));
}

+ (nullable NSString *)completeChatWithModelPath:(NSString *)modelPath
                                          prompt:(NSString *)prompt
                                     contextSize:(NSInteger)contextSize
                                         threads:(NSInteger)threads
                                     temperature:(double)temperature
                                       maxTokens:(NSInteger)maxTokens
                                       requestId:(NSString *)requestId
                                           error:(NSError **)error {
#if JAI_LLAMA_CPP_AVAILABLE
  try {
    std::string generated = completeChatNative(
        stringFromNSString(modelPath),
        stringFromNSString(prompt),
        contextSize,
        threads,
        temperature,
        maxTokens,
        stringFromNSString(requestId));
    return stringFromUtf8(generated);
  } catch (const JaiNativeError &nativeError) {
    assignError(error, makeNSError(nativeError.code(), nativeError.what()));
    return nil;
  } catch (const std::exception &nativeError) {
    assignError(error, makeNSError(@"JAI_LLAMA_CPP_INFERENCE_FAILED", [NSString stringWithUTF8String:nativeError.what()]));
    return nil;
  }
#else
  (void)prompt;
  (void)contextSize;
  (void)threads;
  (void)temperature;
  (void)maxTokens;
  (void)requestId;
  assignError(error, missingBackendError(@"completeChat", modelPath));
  return nil;
#endif
}

+ (nullable NSArray<NSNumber *> *)embedTextWithModelPath:(NSString *)modelPath
                                                    text:(NSString *)text
                                             contextSize:(NSInteger)contextSize
                                                 threads:(NSInteger)threads
                                                   error:(NSError **)error {
#if JAI_LLAMA_CPP_AVAILABLE
  try {
    std::vector<float> embedding = embedTextNative(
        stringFromNSString(modelPath),
        stringFromNSString(text),
        contextSize,
        threads);
    NSMutableArray<NSNumber *> *array = [NSMutableArray arrayWithCapacity:embedding.size()];
    for (float value : embedding) {
      [array addObject:@(value)];
    }
    return array;
  } catch (const JaiNativeError &nativeError) {
    assignError(error, makeNSError(nativeError.code(), nativeError.what()));
    return nil;
  } catch (const std::exception &nativeError) {
    assignError(error, makeNSError(@"JAI_LLAMA_CPP_EMBEDDING_FAILED", [NSString stringWithUTF8String:nativeError.what()]));
    return nil;
  }
#else
  (void)text;
  (void)contextSize;
  (void)threads;
  assignError(error, missingBackendError(@"embedText", modelPath));
  return nil;
#endif
}

@end
