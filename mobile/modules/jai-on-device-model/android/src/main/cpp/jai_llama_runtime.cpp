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
      ", but the llama.cpp backend is not implemented in this build. Exact remaining TODOs: "
      "load the downloaded GGUF path with llama_model_load_from_file, create a llama_context with the requested context size/thread count, format/tokenize the prompt, decode tokens up to maxTokens, apply temperature sampling, return generated UTF-8 text, and implement embedding extraction for the Qwen embedding model. The native module must never call backend/OpenAI.";
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
  // TODO(llama.cpp): Replace this honest failure with the real implementation:
  // 1. llama_backend_init();
  // 2. llama_model_load_from_file(model_path_utf8.c_str(), model_params);
  // 3. llama_new_context_with_model(model, ctx_params with n_ctx/context_size and threads);
  // 4. llama_tokenize(prompt_utf8), llama_decode loop, sampler chain using temperature;
  // 5. stop on EOS or max_tokens, return generated UTF-8 as NewStringUTF;
  // 6. cache/reuse model/context safely or add explicit unload/cancel APIs.
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
  // TODO(llama.cpp): Replace this honest failure with the real embedding path:
  // 1. Load/reuse the Qwen embedding GGUF from model_path_utf8.
  // 2. Create an embedding-enabled llama_context with n_ctx/context_size and threads.
  // 3. Tokenize text_utf8, run llama_decode, read llama_get_embeddings[_seq].
  // 4. Normalize/validate vector dimensions and return a jfloatArray.
#endif

  throwBackendMissing(env, "nativeEmbedText", model_path_utf8.c_str());
  return nullptr;
}
