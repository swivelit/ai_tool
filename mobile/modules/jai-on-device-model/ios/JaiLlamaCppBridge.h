#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Objective-C++ llama.cpp bridge for local-only GGUF inference.
///
/// These methods load downloaded app-private GGUF file paths and never call
/// backend/OpenAI. If llama.cpp is not linked into the pod, they fail clearly
/// with JAI_LLAMA_CPP_BACKEND_MISSING.
@interface JaiLlamaCppBridge : NSObject

+ (nullable NSString *)completeChatWithModelPath:(NSString *)modelPath
                                          prompt:(NSString *)prompt
                                     contextSize:(NSInteger)contextSize
                                         threads:(NSInteger)threads
                                     temperature:(double)temperature
                                       maxTokens:(NSInteger)maxTokens
                                           error:(NSError **)error;

+ (nullable NSArray<NSNumber *> *)embedTextWithModelPath:(NSString *)modelPath
                                                    text:(NSString *)text
                                             contextSize:(NSInteger)contextSize
                                                 threads:(NSInteger)threads
                                                   error:(NSError **)error;

@end

NS_ASSUME_NONNULL_END
