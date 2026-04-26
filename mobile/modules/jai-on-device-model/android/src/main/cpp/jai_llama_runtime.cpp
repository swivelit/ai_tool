#include <jni.h>
#include <string>

namespace {

void throwMissingBackend(JNIEnv *env, const char *operation, const char *model_path) {
  jclass exception_class = env->FindClass("java/lang/IllegalStateException");
  if (exception_class == nullptr) {
    return;
  }

  std::string message =
      "JaiOnDeviceModel error [JAI_LLAMA_CPP_BACKEND_MISSING]: " +
      std::string(operation) +
      " reached libjai_llama_runtime.so for model " +
      std::string(model_path == nullptr ? "<missing>" : model_path) +
      ", but llama.cpp is not linked yet. Add llama.cpp model loading, tokenization, decoding, and embedding extraction before claiming Gemma/Qwen runs on-device.";
  env->ThrowNew(exception_class, message.c_str());
}

} // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_com_harishajahan_jai_ondevice_JaiLlamaCppBinding_nativeCompleteChat(
    JNIEnv *env,
    jobject /* thiz */,
    jstring model_path,
    jstring /* prompt */,
    jint /* context_size */,
    jint /* threads */,
    jdouble /* temperature */,
    jint /* max_tokens */) {
  const char *path = model_path ? env->GetStringUTFChars(model_path, nullptr) : nullptr;
  throwMissingBackend(env, "nativeCompleteChat", path);
  if (path) {
    env->ReleaseStringUTFChars(model_path, path);
  }
  return nullptr;
}

extern "C" JNIEXPORT jfloatArray JNICALL
Java_com_harishajahan_jai_ondevice_JaiLlamaCppBinding_nativeEmbedText(
    JNIEnv *env,
    jobject /* thiz */,
    jstring model_path,
    jstring /* text */,
    jint /* context_size */,
    jint /* threads */) {
  const char *path = model_path ? env->GetStringUTFChars(model_path, nullptr) : nullptr;
  throwMissingBackend(env, "nativeEmbedText", path);
  if (path) {
    env->ReleaseStringUTFChars(model_path, path);
  }
  return nullptr;
}
