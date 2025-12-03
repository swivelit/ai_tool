import React, { useState } from "react";
import { StyleSheet, Text, TextInput, View, Button } from "react-native";

type AnalysisResult = {
  intent: string;
  category: string;
  raw_text: string;
};

const API_BASE = "http://localhost:8000"; // works in Expo Web while backend runs locally

export default function HomeScreen() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const analyzeText = async () => {
    setError("");
    setResult(null);

    if (!input.trim()) {
      setError("Please type something in Tamil to analyze.");
      return;
    }

    try {
      setLoading(true);
      const response = await fetch(`${API_BASE}/analyze-text`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: input }),
      });

      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`);
      }

      const data: AnalysisResult = await response.json();
      setResult(data);
    } catch (err) {
      console.error(err);
      setError("Failed to connect to backend. Is it running on port 8000?");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Tamil Voice AI – Text Test</Text>
      <Text style={styles.subtitle}>
        Type a Tamil instruction (we’ll switch to mic later). I’ll classify it.
      </Text>

      <TextInput
        style={styles.input}
        placeholder="உங்களோட தமிழ் instruction இங்கே type பண்ணுங்க..."
        value={input}
        onChangeText={setInput}
        multiline
      />

      <View style={styles.buttonWrapper}>
        <Button
          title={loading ? "Analyzing..." : "Analyze"}
          onPress={analyzeText}
          disabled={loading}
        />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {result && (
        <View style={styles.resultContainer}>
          <Text style={styles.resultTitle}>Result</Text>
          <Text>Intent: {result.intent}</Text>
          <Text>Category: {result.category}</Text>
          <Text>Raw Text: {result.raw_text}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 60,
    paddingHorizontal: 16,
    backgroundColor: "#f5f5f5",
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: "#555",
    marginBottom: 16,
  },
  input: {
    minHeight: 100,
    borderColor: "#ccc",
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
    backgroundColor: "#fff",
    textAlignVertical: "top",
  },
  buttonWrapper: {
    marginBottom: 8,
  },
  error: {
    marginTop: 8,
    color: "red",
  },
  resultContainer: {
    marginTop: 20,
    padding: 12,
    borderRadius: 8,
    backgroundColor: "#fff",
    borderColor: "#ddd",
    borderWidth: 1,
  },
  resultTitle: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 4,
  },
});
