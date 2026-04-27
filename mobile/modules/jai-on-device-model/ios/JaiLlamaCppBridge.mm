#import "JaiLlamaCppBridge.h"

static NSString *const JaiLlamaCppBridgeErrorDomain = @"JaiOnDeviceModel";

@implementation JaiLlamaCppBridge

+ (NSError *)missingBackendErrorForOperation:(NSString *)operation modelPath:(NSString *)modelPath {
  NSString *message = [NSString stringWithFormat:
    @"JaiOnDeviceModel error [JAI_LLAMA_CPP_BACKEND_MISSING]: %@ reached the Objective-C++ bridge for model %@, but llama.cpp is not linked/implemented yet. Exact remaining TODOs: load the downloaded GGUF path with llama_model_load_from_file, create a llama_context with the requested context size/thread count, format/tokenize prompts, decode tokens up to maxTokens with temperature sampling, return generated UTF-8 text, and implement embedding extraction for the Qwen embedding model. The native module must never call backend/OpenAI.",
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
  if (error != nil) {
    *error = [self missingBackendErrorForOperation:@"embedText" modelPath:modelPath];
  }
  return nil;
}

@end
