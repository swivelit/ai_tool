#import "JaiLlamaCppBridge.h"

static NSString *const JaiLlamaCppBridgeErrorDomain = @"JaiOnDeviceModel";

@implementation JaiLlamaCppBridge

+ (NSError *)missingBackendErrorForOperation:(NSString *)operation modelPath:(NSString *)modelPath {
  NSString *message = [NSString stringWithFormat:
    @"JaiOnDeviceModel error [JAI_LLAMA_CPP_BACKEND_MISSING]: %@ reached the Objective-C++ bridge for model %@, but llama.cpp is not linked/implemented yet. Exact remaining native work: vendor llama.cpp or link a prebuilt llama.cpp static library in JaiOnDeviceModel.podspec, include llama.h from Objective-C++, load the downloaded GGUF path with llama_model_load_from_file, create/reuse a llama_context with contextSize/thread count, tokenize the already formatted prompt, decode prompt and generated tokens, apply temperature sampling, stop on EOS/maxTokens, return generated UTF-8 text, implement embedding-enabled context setup and llama_get_embeddings_seq/llama_get_embeddings_ith extraction for the Qwen embedding model, and free/reuse model/context resources safely. The native module must never call backend/OpenAI.",
    operation,
    modelPath.length ? modelPath : @"<missing>"];
  return [NSError errorWithDomain:JaiLlamaCppBridgeErrorDomain
                             code:1001
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

+ (nullable NSString *)completeChatWithModelPath:(NSString *)modelPath
                                          prompt:(NSString *)prompt
                                     contextSize:(NSInteger)contextSize
                                         threads:(NSInteger)threads
                                     temperature:(double)temperature
                                       maxTokens:(NSInteger)maxTokens
                                           error:(NSError **)error {
  (void)prompt;
  (void)contextSize;
  (void)threads;
  (void)temperature;
  (void)maxTokens;

  // Build-ready implementation target:
  // 1. Add llama.cpp sources/static library in JaiOnDeviceModel.podspec.
  // 2. llama_backend_init(); keep process-global init idempotent.
  // 3. llama_model_load_from_file([modelPath fileSystemRepresentation], model_params).
  // 4. llama_new_context_with_model(model, ctx_params with n_ctx=contextSize, embeddings=false).
  // 5. Tokenize prompt with llama_model_get_vocab(model)/llama_tokenize.
  // 6. Decode prompt and generated tokens; enforce maxTokens and EOS.
  // 7. Use a sampler chain with temperature/distribution sampling.
  // 8. Convert generated token pieces to NSString and return it.
  // 9. Cache/reuse resources by modelPath, and release them safely when replaced.
  if (error != nil) {
    *error = [self missingBackendErrorForOperation:@"completeChat" modelPath:modelPath];
  }
  return nil;
}

+ (nullable NSArray<NSNumber *> *)embedTextWithModelPath:(NSString *)modelPath
                                                    text:(NSString *)text
                                             contextSize:(NSInteger)contextSize
                                                 threads:(NSInteger)threads
                                                   error:(NSError **)error {
  (void)text;
  (void)contextSize;
  (void)threads;

  // Build-ready implementation target:
  // 1. Load/reuse the Qwen embedding GGUF from modelPath.
  // 2. Create an embedding-enabled llama_context with n_ctx=contextSize.
  // 3. Tokenize text, batch/decode it, then read pooled sequence embeddings with
  //    llama_get_embeddings_seq(ctx, seq_id), or token embeddings with
  //    llama_get_embeddings_ith when the pooling type is NONE.
  // 4. Validate dimension from llama_model_n_embd(model), wrap floats as NSNumber,
  //    and return NSArray<NSNumber *> to Swift.
  if (error != nil) {
    *error = [self missingBackendErrorForOperation:@"embedText" modelPath:modelPath];
  }
  return nil;
}

@end
