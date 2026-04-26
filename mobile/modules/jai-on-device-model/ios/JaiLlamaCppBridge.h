#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Objective-C++ seam for the future llama.cpp iOS backend.
///
/// The Swift Expo module keeps failing honestly with JAI_LLAMA_CPP_BACKEND_MISSING
/// until these methods are implemented with real llama.cpp model loading,
/// decoding, and embedding extraction.
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
