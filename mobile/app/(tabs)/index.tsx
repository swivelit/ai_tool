import React, { useState } from "react";
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  Button,
  Platform,
} from "react-native";
import { Audio } from "expo-av";

type AnalysisResult = {
  intent: string;
  category: string;
  raw_text: string;
  transcript?: string;
};

//const API_BASE = "http://localhost:8000"; // for web. For device, we will adjust.
const API_BASE = "http://10.206.228.221:8000";


export default function HomeScreen() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [recordingStatus, setRecordingStatus] = useState<"idle" | "recording">(
    "idle"
  );

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

  const startRecording = async () => {
    if (Platform.OS === "web") {
      setError("Voice recording not supported on web. Use Android/iOS via Expo Go.");
      return;
    }

    try {
      setError("");
      setResult(null);

      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        setError("Microphone permission is required.");
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );

      setRecording(recording);
      setRecordingStatus("recording");
    } catch (err) {
      console.error("Error starting recording", err);
      setError("Failed to start recording.");
    }
  };

  const stopRecordingAndAnalyze = async () => {
    if (!recording) return;

    try {
      setRecordingStatus("idle");
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      setRecording(null);

      if (!uri) {
        setError("No audio URI found after recording.");
        return;
      }

      setLoading(true);
      setError("");

      // NOTE: When using a real device, API_BASE cannot be localhost.
      // We'll fix that in a later step with your machine's IP.
      const formData = new FormData();
      formData.append("file", {
        uri,
        name: "audio.m4a",
        type: "audio/m4a",
      } as any);

      const response = await fetch(`${API_BASE}/transcribe-and-analyze`, {
        method: "POST",
        headers: {
          // Do NOT set Content-Type manually for FormData in React Native
        } as any,
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`);
      }

      const data: AnalysisResult = await response.json();
      setResult(data);
      setInput(data.transcript || "");
    } catch (err) {
      console.error("Error stopping recording or calling API", err);
      setError(
        "Failed to send audio to backend. Make sure backend is reachable from your device."
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Tamil Voice AI – Text & Voice</Text>
      <Text style={styles.subtitle}>
        Type a Tamil instruction or use voice (Android/iOS).
      </Text>

      {/* Text input test area */}
      <TextInput
        style={styles.input}
        placeholder="உங்களோட தமிழ் instruction இங்கே type பண்ணுங்க..."
        value={input}
        onChangeText={setInput}
        multiline
      />

      <View style={styles.buttonWrapper}>
        <Button
          title={loading ? "Analyzing..." : "Analyze Text"}
          onPress={analyzeText}
          disabled={loading}
        />
      </View>

      {/* Voice controls */}
      <View style={styles.voiceSection}>
        <Text style={styles.sectionTitle}>Voice (Tamil)</Text>
        {Platform.OS === "web" ? (
          <Text style={styles.infoText}>
            Voice recording not supported on web. Open this in Expo Go on an
            Android/iOS device.
          </Text>
        ) : (
          <>
            {recordingStatus === "idle" ? (
              <Button
                title="🎙 Start Recording"
                onPress={startRecording}
                disabled={loading}
              />
            ) : (
              <Button
                title="⏹ Stop & Analyze"
                onPress={stopRecordingAndAnalyze}
                color="#b00020"
              />
            )}
          </>
        )}
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {result && (
        <View style={styles.resultContainer}>
          <Text style={styles.resultTitle}>Result</Text>
          <Text>Intent: {result.intent}</Text>
          <Text>Category: {result.category}</Text>
          <Text>Raw Text / Transcript: {result.raw_text}</Text>
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
    marginBottom: 16,
  },
  voiceSection: {
    marginTop: 8,
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 4,
  },
  infoText: {
    fontSize: 13,
    color: "#666",
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
