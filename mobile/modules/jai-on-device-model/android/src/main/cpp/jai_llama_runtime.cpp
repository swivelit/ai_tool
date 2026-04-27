#include <jni.h>
#include <string>

namespace {

void throwBackendMissing(JNIEnv *env, const char *operation, const char *model_path) {
  jclass exception_class = env->FindClass("java/lang/IllegalStateException");
  if (exception_class == nullptr) {
    return;
  }

  std::string message =
      "JaiOnDeviceModel error [JAI_LLAMA_CPP_BACKEND_MISSING]: " +
      std::string(operation) +
      " reached libjai_llama_runtime.so for model " +
      std::string(model_path == nullptr ? "<missing>" : model_path) +
      ", but the llama.cpp backend is not implemented in this build. Exact remaining native work: "
      "vendor llama.cpp with CMake, include llama.h, load the downloaded GGUF path with "
      "llama_model_load_from_file, create/reuse a llama_context with contextSize/batchSize/thread count, "
      "tokenize the already formatted prompt, decode prompt and generated tokens, apply temperature sampling, "
      "stop on EOS/maxTokens, return generated UTF-8 text, implement embedding-enabled context setup and "
      "llama_get_embeddings_seq/llama_get_embeddings_ith extraction for the Qwen embedding model, and free/reuse "
      "model/context resources safely. The native module must never call backend/OpenAI.";
  env->ThrowNew(exception_class, message.c_str());
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
  (void)prompt_utf8;
  (void)context_size;
  (void)threads;
  (void)temperature;
  (void)max_tokens;

#if JAI_LLAMA_CPP_AVAILABLE
  // Build-ready implementation target:
  // 1. llama_backend_init(); keep process-global init idempotent.
  // 2. llama_model_default_params(); llama_model_load_from_file(model_path_utf8.c_str(), params).
  // 3. llama_context_default_params(); set n_ctx=context_size, n_batch, embeddings=false.
  // 4. llama_new_context_with_model(model, ctx_params); set thread count on decode paths.
  // 5. llama_model_get_vocab(model); llama_tokenize(vocab, prompt_utf8.c_str(), ...).
  // 6. Feed llama_batch/llama_decode for prompt tokens.
  // 7. Build a llama_sampler chain with temperature and distribution sampling.
  // 8. Decode one token at a time until EOS, stop token, or max_tokens.
  // 9. Convert tokens to UTF-8 pieces and return env->NewStringUTF(generated.c_str()).
  // 10. Cache/reuse model/context by model_path_utf8 or free with llama_free/llama_model_free.
#endif

  throwBackendMissing(env, "nativeCompleteChat", model_path_utf8.c_str());
  return nullptr;
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
  (void)text_utf8;
  (void)context_size;
  (void)threads;

#if JAI_LLAMA_CPP_AVAILABLE
  // Build-ready implementation target:
  // 1. Load/reuse the Qwen embedding GGUF from model_path_utf8.
  // 2. Create a llama_context with ctx_params.embeddings=true and n_ctx=context_size.
  // 3. Tokenize text_utf8, create a batch with a sequence id, and run llama_decode.
  // 4. Prefer pooled sequence embeddings with llama_get_embeddings_seq(ctx, seq_id).
  // 5. If pooling is NONE, use llama_get_embeddings_ith for the final/output token.
  // 6. Validate dimension from llama_model_n_embd(model), copy to jfloatArray, return it.
#endif

  throwBackendMissing(env, "nativeEmbedText", model_path_utf8.c_str());
  return nullptr;
}
