import React, { useEffect, useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  Button,
  ScrollView,
  ActivityIndicator,
  Alert,
} from "react-native";

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

const API_BASE = "http://10.206.228.221:8000"; // same as in index.tsx

export default function ExploreScreen() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [generatingId, setGeneratingId] = useState<number | null>(null);
  const [error, setError] = useState("");

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

  const generateDocx = async (itemId: number) => {
    setGeneratingId(itemId);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/items/${itemId}/generate-docx`, {
        method: "POST",
      });
      if (!res.ok) {
        throw new Error(`Server error: ${res.status}`);
      }
      const data = await res.json();
      Alert.alert(
        "Word Document Created",
        `Path (on backend): ${data.docx_path}`
      );
    } catch (err) {
      console.error(err);
      setError("Failed to generate Word document.");
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
                  title={
                    generatingId === item.id ? "Generating..." : "Generate Word"
                  }
                  onPress={() => generateDocx(item.id)}
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
    alignSelf: "flex-start",
  },
});
