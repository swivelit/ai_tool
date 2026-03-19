import pandas as pd
import time
from sklearn.metrics.pairwise import cosine_similarity
from sentence_transformers import SentenceTransformer

# import your existing openai pipeline
from stage_openai_core import OpenAICore


# load semantic similarity model
similarity_model = SentenceTransformer("all-mpnet-base-v2")

# initialize pipeline
pipeline = OpenAICore()


def similarity_score(expected, generated):
    emb1 = similarity_model.encode([str(expected)])
    emb2 = similarity_model.encode([str(generated)])

    score = cosine_similarity(emb1, emb2)[0][0]
    return score


def evaluate(csv_file):

    df = pd.read_csv(csv_file)

    results = []

    total_similarity = 0
    total_time = 0

    for index, row in df.iterrows():

        question = str(row["question"])
        condition = str(row["condition"])
        expected_answer = str(row["answer"])

        start = time.time()

        # call correct method from OpenAICore
        generated_answer = pipeline.answer_user_query(
            f"""
            Answer the following question briefly (2–3 sentences) and keep the meaning close to the user's personality condition.

        Condition: {condition}
        Question: {question}
        """,
            condition
        )

        latency = time.time() - start

        score = similarity_score(expected_answer, generated_answer)

        total_similarity += score
        total_time += latency

        results.append({
            "question": question,
            "expected": expected_answer,
            "generated": generated_answer,
            "similarity": score,
            "latency": latency
        })

        print("\n----------------------------")
        print("Question:", question)
        print("Condition:", condition)
        print("Expected:", expected_answer)
        print("Generated:", generated_answer)
        print("Similarity:", round(score, 4))
        print("Latency:", round(latency, 3), "seconds")

    avg_similarity = total_similarity / len(df)
    avg_latency = total_time / len(df)

    print("\n===============================")
    print("Total Questions:", len(df))
    print("Average Similarity:", round(avg_similarity, 4))
    print("Average Latency:", round(avg_latency, 3), "seconds")

    return results


if __name__ == "__main__":

    dataset_path = "dataset.csv"

    evaluate(dataset_path)