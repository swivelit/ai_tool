#import "JaiLlamaCppBridge.h"

static NSString *const JaiLlamaCppBridgeErrorDomain = @"JaiOnDeviceModel";

@implementation JaiLlamaCppBridge

+ (NSError *)missingBackendErrorForOperation:(NSString *)operation modelPath:(NSString *)modelPath {
  NSString *message = [NSString stringWithFormat:
    @"JaiOnDeviceModel error [JAI_LLAMA_CPP_BACKEND_MISSING]: %@ reached the Objective-C++ bridge for model %@, but llama.cpp is not linked yet. Add llama.cpp model loading, tokenization, decoding, and embedding extraction before claiming Gemma/Qwen runs on-device.",
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
