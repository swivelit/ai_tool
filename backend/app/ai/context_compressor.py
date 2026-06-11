
class ContextCompressor:

    def compress(self, chunks):

        if not chunks:
            return []

        return chunks[:3]