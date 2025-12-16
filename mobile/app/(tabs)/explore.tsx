import React, { useEffect, useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  Button,
  ScrollView,
  ActivityIndicator,
  Alert,
  TextInput,
  Platform,
} from "react-native";
import { Audio } from "expo-av";

type Item = {
  id: number;
  intent: string;
  category: string;
  raw_text: string;
  transcript?: string | null;
  datetime?: string | null;
  title?: string | null;
  details?: string | null;
};

type GenerateResponse = {
  item_id: number;
  docx_path?: string;
  pdf_path?: string;
  excel_path?: string;
  ppt_path?: string;
  category: string;
};

type SearchResponse = {
  items: Item[];
  transcript?: string | null;
};

const API_BASE = "http://10.206.228.221:8000"; // same as in index.tsx

const [searchText, setSearchText] = useState("");
const [searching, setSearching] = useState(false);

export default function ExploreScreen() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [generatingId, setGeneratingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  const [searchText, setSearchText] = useState("");
  const [searching, setSearching] = useState(false);

  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [recordingStatus, setRecordingStatus] = useState<"idle" | "recording">(
    "idle"
  );

  const fetchItems = async () => {
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/items`);
      if (!res.ok) {
        throw new Error(`Server error: ${res.status}`);
      }
      const data: Item[] = await res.json();
      setItems(data);
    } catch (err) {
      console.error(err);
      setError("Failed to load items from backend.");
    } finally {
      setLoading(false);
    }
  };

  const searchItems = async () => {
    if (!searchText.trim()) {
      // empty query -> load all items again
      fetchItems();
      return;
    }
    setError("");
    setSearching(true);
    try {
      const res = await fetch(`${API_BASE}/search-items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchText }),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data: SearchResponse = await res.json();
      setItems(data.items || []);
    } catch (err) {
      console.error(err);
      setError("Search failed.");
    } finally {
      setSearching(false);
    }
  };

  const startVoiceSearch = async () => {
    if (Platform.OS === "web") {
      setError("Voice search not supported on web. Use Android/iOS via Expo Go.");
      return;
    }

    try {
      setError("");
      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        setError("Microphone permission is required for voice search.");
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
      console.error("Error starting voice search recording", err);
      setError("Failed to start voice search.");
    }
  };

  const stopVoiceSearch = async () => {
    if (!recording) return;

    try {
      setRecordingStatus("idle");
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      setRecording(null);

      if (!uri) {
        setError("No audio URI found for voice search.");
        return;
      }

      setSearching(true);
      setError("");

      const formData = new FormData();
      formData.append("file", {
        uri,
        name: "search_audio.m4a",
        type: "audio/m4a",
      } as any);

      const res = await fetch(`${API_BASE}/search-items-voice`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) throw new Error(`Server error: ${res.status}`);

      const data: SearchResponse = await res.json();
      setItems(data.items || []);
      if (data.transcript) {
        setSearchText(data.transcript);
      }
    } catch (err) {
      console.error("Error in voice search", err);
      setError("Voice search failed.");
    } finally {
      setSearching(false);
    }
  };

  const generateDocx = async (itemId: number) => {
    setGeneratingId(itemId);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/items/${itemId}/generate-docx`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data: GenerateResponse = await res.json();
      Alert.alert("Word Document Created", `Backend path: ${data.docx_path}`);
    } catch (err) {
      console.error(err);
      setError("Failed to generate Word document.");
    } finally {
      setGeneratingId(null);
    }
  };

  const generatePdf = async (itemId: number) => {
    setGeneratingId(itemId);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/items/${itemId}/generate-pdf`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data: GenerateResponse = await res.json();
      Alert.alert("PDF Created", `Backend path: ${data.pdf_path}`);
    } catch (err) {
      console.error(err);
      setError("Failed to generate PDF.");
    } finally {
      setGeneratingId(null);
    }
  };

  const generateExcel = async (itemId: number) => {
    setGeneratingId(itemId);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/items/${itemId}/generate-excel`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data: GenerateResponse = await res.json();
      Alert.alert("Excel Created", `Backend path: ${data.excel_path}`);
    } catch (err) {
      console.error(err);
      setError("Failed to generate Excel.");
    } finally {
      setGeneratingId(null);
    }
  };

  const generatePpt = async (itemId: number) => {
    setGeneratingId(itemId);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/items/${itemId}/generate-ppt`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data: GenerateResponse = await res.json();
      Alert.alert("PPT Created", `Backend path: ${data.ppt_path}`);
    } catch (err) {
      console.error(err);
      setError("Failed to generate PPT.");
    } finally {
      setGeneratingId(null);
    }
  };

  useEffect(() => {
    fetchItems();
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Saved Items</Text>
      <Text style={styles.subtitle}>
        All tasks / notes / reminders created from Tamil commands.
      </Text>

      <View style={styles.refreshRow}>
        <Button title="Refresh" onPress={fetchItems} />
      </View>

      {loading && <ActivityIndicator style={{ marginTop: 10 }} />}

      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={{ marginBottom: 12 }}>
        <Text style={{ marginBottom: 4 }}>Search (Tamil / English)</Text>
        <View style={{ flexDirection: "row", marginBottom: 8 }}>
          <View style={{ flex: 1, marginRight: 8 }}>
            <TextInput
              style={styles.searchInput}
              placeholder="நேத்து சொன்ன note..."
              value={searchText}
              onChangeText={setSearchText}
            />
          </View>
          <Button
            title={searching ? "..." : "Search"}
            onPress={searchItems}
            disabled={searching}
          />
        </View>

        <View style={{ flexDirection: "row", alignItems: "center" }}>
          {Platform.OS === "web" ? (
            <Text style={{ fontSize: 12, color: "#666" }}>
              Voice search not supported on web.
            </Text>
          ) : recordingStatus === "idle" ? (
            <Button title="🎙 Voice Search" onPress={startVoiceSearch} />
          ) : (
            <Button title="⏹ Stop" color="#b00020" onPress={stopVoiceSearch} />
          )}

          <View style={{ width: 12 }} />
          <Button title="Clear" onPress={() => { setSearchText(""); fetchItems(); }} />
        </View>
      </View>

      <ScrollView style={styles.list}>
        {items.length === 0 && !loading ? (
          <Text style={styles.emptyText}>
            No items yet. Go to Home and create one using text or voice.
          </Text>
        ) : (
          items.map((item) => (
            <View key={item.id} style={styles.card}>
              <Text style={styles.cardTitle}>
                #{item.id} {item.title || "(No title)"}
              </Text>
              <Text>Intent: {item.intent}</Text>
              <Text>Category: {item.category}</Text>
              {item.datetime ? <Text>When: {item.datetime}</Text> : null}
              {item.details ? (
                <Text numberOfLines={2}>Details: {item.details}</Text>
              ) : (
                <Text numberOfLines={2}>Text: {item.raw_text}</Text>
              )}

              <View style={styles.cardButtonRow}>
                <Button
                  title={generatingId === item.id ? "..." : "Word"}
                  onPress={() => generateDocx(item.id)}
                  disabled={generatingId === item.id}
                />
                <View style={{ width: 8 }} />
                <Button
                  title="PDF"
                  onPress={() => generatePdf(item.id)}
                  disabled={generatingId === item.id}
                />
                <View style={{ width: 8 }} />
                <Button
                  title="Excel"
                  onPress={() => generateExcel(item.id)}
                  disabled={generatingId === item.id}
                />
                <View style={{ width: 8 }} />
                <Button
                  title="PPT"
                  onPress={() => generatePpt(item.id)}
                  disabled={generatingId === item.id}
                />
              </View>
            </View>
          ))
        )}
      </ScrollView>
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
  refreshRow: {
    marginBottom: 12,
    alignSelf: "flex-start",
  },
  error: {
    color: "red",
    marginBottom: 8,
  },
  list: {
    flex: 1,
  },
  emptyText: {
    marginTop: 20,
    fontSize: 14,
    color: "#666",
  },
  card: {
    marginBottom: 12,
    padding: 12,
    backgroundColor: "#fff",
    borderRadius: 8,
    borderColor: "#ddd",
    borderWidth: 1,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 4,
  },
  cardButtonRow: {
    marginTop: 8,
    flexDirection: "row",
    flexWrap: "wrap",
  },
  searchInput: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: "#fff",
  },
});
