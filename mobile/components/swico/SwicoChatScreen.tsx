import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, Platform,
  Image, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

import { useAuth } from "@/components/AuthProvider";
import { Screen } from "@/components/ui";
import { type Palette } from "@/constants/theme";
import { useAppTheme } from "@/hooks/use-app-theme";
import { MarkdownText } from "./MarkdownText";
import { continuationMarkdown, stitchContinuationMarkdown } from "@/lib/continuationMarkdown";
import {
  cancelChatRequest, chatRequestStatus, createVoiceSession, deleteRepository, deleteThread, deleteUpload, endVoiceSession, getBootstrap, getMemorySettings,
  getLedger, getMessages, getPayments, getProfileSettings, getThreads, getUsage, getUsageSettings, listKnowledge, newSwicoRequestId, patchThread, searchChats,
  approveKnowledge, cancelKnowledgeJob, deleteKnowledge, deleteMemory, getKnowledgeJobStatus, reindexKnowledge, sendFeedback, streamChat, synthesizeAudio, transcribeAudioUri, uploadText,
  updateAssistant, updateMemorySettings, updateProfileSettings, uploadDocument, uploadRepository,
  type SwicoApiError,
} from "@/lib/swicoApi";
import { emptySwicoStreamState, reduceSwicoStream, type SwicoStreamState } from "@/lib/swicoChatReducer";
import type { Attachment, Bootstrap, KnowledgeDocument, MemoryFact, Message, ProfileSettings, RepositorySnapshot, Thread } from "@/lib/swicoTypes";
import { SwicoRealtimeVoiceTransport, realtimePcmAvailable } from "@/lib/swicoRealtimeVoice";

function nowIso() { return new Date().toISOString(); }
function makeUserMessage(text: string, requestId: string, threadId: string) : Message {
  return {
    id: `pending-${requestId}`, thread_id: threadId, role: "user", content: text,
    request_id: requestId, tier: null, tier_label: "", input_tokens: 0, output_tokens: 0,
    usage_source: null, charge_micros: 0, status: "pending", created_at: nowIso(),
    input_mode: "text", voice_turn_id: null, reply_language: null,
  };
}

export default function SwicoChatScreen() {
  const { user, signOutUser } = useAuth();
  const { palette: t } = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const insets = useSafeAreaInsets();
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [hasMoreThreads, setHasMoreThreads] = useState(false);
  const [archived, setArchived] = useState(false);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [editTarget, setEditTarget] = useState<string | null>(null);
  const [stream, setStream] = useState<SwicoStreamState>(emptySwicoStreamState);
  const [streaming, setStreaming] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [, setCancellationReady] = useState(false);
  const [error, setError] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [tierModal, setTierModal] = useState(false);
  const [settingsModal, setSettingsModal] = useState(false);
  const [realtimeVoice, setRealtimeVoice] = useState(false);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<{ thread_id: string | null; message_id: string | null; snippet: string }[]>([]);
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [repositoryId, setRepositoryId] = useState<string | undefined>();
  const [repositoryMeta, setRepositoryMeta] = useState<RepositorySnapshot | null>(null);
  const [longInputMode, setLongInputMode] = useState<"summarize" | "analyze" | "ask_questions" | "rewrite" | "translate">("analyze");
  const [uploading, setUploading] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Thread | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [editorMessage, setEditorMessage] = useState<Message | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const cancellationReadyRef = useRef(false);
  const queuedStopRef = useRef(false);
  const cancellationSentRef = useRef(false);
  const stopConfirmedRef = useRef(false);
  const soundRef = useRef<Audio.Sound | null>(null);
  const listRef = useRef<FlatList<Message>>(null);

  const reloadThreads = useCallback(async (isArchived = archived) => {
    if (!user) return;
    const result = await getThreads(user, isArchived);
    setThreads(result.items);
    setHasMoreThreads(result.has_more);
  }, [archived, user]);

  const loadMoreThreads = useCallback(async () => {
    if (!user || !hasMoreThreads) return;
    const result = await getThreads(user, archived, "", threads.length);
    setThreads(value => [...value, ...result.items.filter(item => !value.some(existing => existing.id === item.id))]);
    setHasMoreThreads(result.has_more);
  }, [archived, hasMoreThreads, threads.length, user]);

  const reloadMessages = useCallback(async (threadId: string) => {
    if (!user) return;
    const result = await getMessages(user, threadId);
    setMessages(result.items);
    const restored = new Map<string, Attachment>();
    result.items.forEach(message => (message.attachments || []).forEach(attachment => {
      if (attachment.status === "ready" && new Date(attachment.expires_at).getTime() > Date.now()) restored.set(attachment.id, attachment);
    }));
    setAttachments(Array.from(restored.values()).slice(-5));
    setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    void Promise.all([getBootstrap(user), getThreads(user)]).then(([nextBootstrap, nextThreads]) => {
      if (!alive) return;
      setBootstrap(nextBootstrap);
      setThreads(nextThreads.items);
      setHasMoreThreads(nextThreads.has_more);
    }).catch(() => setError("Swico could not load your workspace. Check your connection and try again."));
    return () => { alive = false; };
  }, [user]);

  useEffect(() => {
    if (activeThread && !streaming) void reloadMessages(activeThread).catch(() => setError("This conversation could not be loaded."));
  }, [activeThread, reloadMessages, streaming]);

  useEffect(() => {
    if (!user || !activeThread || streaming) return;
    const pending = messages.find(item => item.status === "pending" && item.request_id);
    if (!pending?.request_id) return;
    let alive = true;
    const poll = async () => {
      try {
        const status = await chatRequestStatus(user, pending.request_id!);
        const phase = String(status.phase || status.status || "").toLowerCase();
        if (alive && ["completed", "complete", "failed", "cancelled", "stopped", "error"].includes(phase)) {
          await reloadMessages(activeThread);
          await reloadThreads(false);
        }
      } catch {
        // A reconnect poll is best effort; the durable server request remains authoritative.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [activeThread, messages, reloadMessages, reloadThreads, streaming, user]);

  useEffect(() => {
    if (!attachments.some(item => item.status === "ready")) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setAttachments(value => value.map(item => item.status === "ready" && new Date(item.expires_at).getTime() <= now ? { ...item, status: "expired" as const } : item));
    }, 1000);
    return () => clearInterval(timer);
  }, [attachments]);

  useEffect(() => {
    if (!user || !search.trim() || !bootstrap?.features.web_content_search) {
      setSearchResults([]); return;
    }
    const timer = setTimeout(() => void searchChats(user, search).then(result => setSearchResults(result.items)).catch(() => setSearchResults([])), 300);
    return () => clearTimeout(timer);
  }, [bootstrap?.features.web_content_search, search, user]);

  const streamedThreadRef = useRef<string | null>(null);
  const applyStreamEvent = useCallback((event: { event: string; data: unknown }) => {
    if (event.event === "error" && event.data && typeof event.data === "object") {
      const data = event.data as Record<string, unknown>;
      setError(String(data.message || "Swico could not complete that response."));
    }
    setStream(previous => {
      const next = reduceSwicoStream(previous, event);
      if (next.assistant) {
        setMessages(value => [...value.filter(item => item.request_id !== next.assistant?.request_id), next.assistant!]);
      }
      if (next.assistant?.thread_id && next.assistant.thread_id !== "new-thread") {
        streamedThreadRef.current = next.assistant.thread_id;
        setActiveThread(next.assistant.thread_id);
      }
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 20);
      return next;
    });
  }, []);

  const requestServerCancellation = useCallback(async (targetRequestId: string, targetController: AbortController) => {
    if (!user || cancellationSentRef.current) return;
    cancellationSentRef.current = true;
    try {
      const result = await cancelChatRequest(user, targetRequestId);
      if (result.status === "stopped") {
        stopConfirmedRef.current = true;
        await getBootstrap(user).then(setBootstrap).catch(() => undefined);
        targetController.abort();
      } else if (result.status === "cancelling") {
        setError("Cancellation was requested. Swico is finishing the usage record safely.");
      } else {
        setError("Swico had already completed this response.");
      }
    } catch {
      cancellationSentRef.current = false;
      setError("Cancellation could not be confirmed. The stream will remain open until settlement finishes.");
    }
  }, [user]);

  const send = useCallback(async (override?: string, options: { continueId?: string; editId?: string; regenerateId?: string } = {}) => {
    if (!user || streaming) return;
    const rawText = String(override ?? (options.continueId ? "Continue response" : draft));
    const text = rawText.trim();
    if (!text) return;
    let providerText = text;
    let selectedAttachments = attachments;
    const inlineThreshold = bootstrap?.uploads.long_input_inline_threshold_chars || 16000;
    if (!options.continueId && rawText.length > inlineThreshold) {
      if (!bootstrap?.uploads.long_input_enabled || rawText.length > (bootstrap.uploads.long_input_max_chars || 64000)) {
        setError("This pasted text is larger than the server-supported limit.");
        return;
      }
      if (attachments.length >= bootstrap.uploads.max_files_per_message) {
        setError("Remove one attachment before sending this large pasted text.");
        return;
      }
      setUploading(true); setError("Preparing large pasted text…");
      try {
        const virtual = await uploadText(user, rawText, longInputMode) as Attachment;
        selectedAttachments = [...attachments, virtual];
        setAttachments(selectedAttachments.slice(-bootstrap.uploads.max_files_per_message));
        const labels = { summarize: "Summarize", analyze: "Analyze", ask_questions: "Answer questions about", rewrite: "Rewrite", translate: "Translate" };
        providerText = `${labels[longInputMode]} the attached pasted text. Preserve its meaning and cite the supplied chunk labels when useful.`;
      } catch (caught) {
        setUploading(false); setError((caught as Error).message || "Large text upload failed."); return;
      } finally { setUploading(false); }
    }
    const id = newSwicoRequestId();
    const threadId = activeThread || "new-thread";
    const payload = {
      request_id: id, message: providerText, ...(activeThread ? { thread_id: activeThread } : {}),
      attachment_ids: selectedAttachments.map(item => item.id), ...(repositoryId ? { repository_id: repositoryId } : {}),
      input_mode: "text" as const,
      ...(options.continueId ? { continue_message_id: options.continueId } : {}),
      ...((options.editId || editTarget) ? { edit_message_id: options.editId || editTarget! } : {}),
      ...(options.regenerateId ? { regenerate_message_id: options.regenerateId } : {}),
    };
    setDraft(""); setEditTarget(null); setError(""); setStreaming(true); setRequestId(id);
    cancellationReadyRef.current = false;
    queuedStopRef.current = false;
    cancellationSentRef.current = false;
    stopConfirmedRef.current = false;
    setCancellationReady(false);
    streamedThreadRef.current = activeThread;
    setStream({ ...emptySwicoStreamState, phase: "connecting", assistant: {
      id: `stream-${id}`, thread_id: threadId, role: "assistant", content: "", request_id: id,
      tier: bootstrap?.assistant.tier || null, tier_label: bootstrap?.assistant.tier_label || "Swico",
      input_tokens: 0, output_tokens: 0, usage_source: null, charge_micros: 0, status: "streaming",
      created_at: nowIso(), input_mode: "text", voice_turn_id: null, reply_language: null,
    }});
    setMessages(value => [...value, { ...makeUserMessage(providerText, id, threadId), attachments: selectedAttachments }]);
    const controller = new AbortController(); controllerRef.current = controller;
    try {
      await streamChat(user, payload, {
        onAccepted: () => {
          cancellationReadyRef.current = true;
          setCancellationReady(true);
          if (queuedStopRef.current) {
            queuedStopRef.current = false;
            void requestServerCancellation(id, controller);
          }
        },
        onEvent: applyStreamEvent,
      }, controller.signal);
      if (activeThread || streamedThreadRef.current) {
        const resolved = activeThread || streamedThreadRef.current;
        if (resolved) await reloadMessages(resolved);
      }
      await Promise.all([reloadThreads(false), getBootstrap(user).then(setBootstrap)]);
    } catch (caught) {
      if ((caught as { name?: string }).name === "AbortError" && stopConfirmedRef.current) {
        setStream(previous => reduceSwicoStream(previous, { event: "done", data: { cancelled: true } }));
        setError("Generation stopped. Partial measured usage may already have been charged.");
        const resolved = activeThread || streamedThreadRef.current;
        if (resolved) await reloadMessages(resolved).catch(() => undefined);
      } else if ((caught as { name?: string }).name !== "AbortError") {
        const apiError = caught as Partial<SwicoApiError>;
        setError(apiError.message || "Swico could not complete that response.");
      }
    } finally {
      cancellationReadyRef.current = false;
      queuedStopRef.current = false;
      cancellationSentRef.current = false;
      stopConfirmedRef.current = false;
      setCancellationReady(false);
      controllerRef.current = null; setStreaming(false); setRequestId(null);
    }
  }, [activeThread, applyStreamEvent, attachments, bootstrap?.assistant.tier, bootstrap?.assistant.tier_label, bootstrap?.uploads.long_input_enabled, bootstrap?.uploads.long_input_inline_threshold_chars, bootstrap?.uploads.long_input_max_chars, bootstrap?.uploads.max_files_per_message, draft, editTarget, longInputMode, reloadMessages, reloadThreads, repositoryId, requestServerCancellation, streaming, user]);

  const stop = useCallback(async () => {
    if (!user || !requestId) return;
    setError("Stopping generation safely…");
    const controller = controllerRef.current;
    if (!controller || !cancellationReadyRef.current) {
      queuedStopRef.current = true;
      return;
    }
    await requestServerCancellation(requestId, controller);
  }, [requestId, requestServerCancellation, user]);

  const playVoice = useCallback(async (message: Message) => {
    if (!user || message.role !== "assistant" || !bootstrap?.features.web_voice_reply) return;
    if (bootstrap.assistant.tier === "free") {
      setError("Swico Free is text only. Switch tiers to hear a reply.");
      return;
    }
    try {
      if (soundRef.current) {
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }
      const audio = await synthesizeAudio(user, {
        operation_id: newSwicoRequestId(),
        message_id: message.id,
        voice_turn_id: message.voice_turn_id || message.request_id || newSwicoRequestId(),
      });
      const uri = `${FileSystem.cacheDirectory || ""}swico-reply-${Date.now()}.m4a`;
      await FileSystem.writeAsStringAsync(uri, audio.audio_base64, { encoding: FileSystem.EncodingType.Base64 });
      const loaded = await Audio.Sound.createAsync({ uri }, { shouldPlay: true });
      soundRef.current = loaded.sound;
      loaded.sound.setOnPlaybackStatusUpdate(status => {
        if (status.isLoaded && status.didJustFinish) {
          void loaded.sound.unloadAsync().catch(() => undefined);
          void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
          soundRef.current = null;
        }
      });
    } catch (caught) {
      setError((caught as Error).message || "Swico could not play that reply.");
    }
  }, [bootstrap, user]);

  useEffect(() => () => { void soundRef.current?.unloadAsync().catch(() => undefined); }, []);

  const threadAction = useCallback((thread: Thread) => {
    Alert.alert(thread.title || "Chat actions", undefined, [
      { text: "Rename", onPress: () => { setRenameTarget(thread); setRenameTitle(thread.title || ""); } },
      { text: thread.archived_at ? "Unarchive" : "Archive", onPress: async () => {
        try { await patchThread(user!, thread.id, { archived: !thread.archived_at }); if (activeThread === thread.id) { setActiveThread(null); setMessages([]); } await reloadThreads(archived); } catch (caught) { setError((caught as Error).message); }
      } },
      { text: "Delete", style: "destructive", onPress: async () => {
        try { await deleteThread(user!, thread.id); if (activeThread === thread.id) { setActiveThread(null); setMessages([]); } await reloadThreads(archived); } catch (caught) { setError((caught as Error).message); }
      } },
      { text: "Cancel", style: "cancel" },
    ]);
  }, [activeThread, archived, reloadThreads, user]);

  const saveRename = useCallback(async () => {
    if (!user || !renameTarget || !renameTitle.trim()) return;
    try {
      await patchThread(user, renameTarget.id, { title: renameTitle.trim() });
      setRenameTarget(null);
      await reloadThreads(archived);
    } catch (caught) { setError((caught as Error).message); }
  }, [archived, reloadThreads, renameTarget, renameTitle, user]);

  const chooseThread = (id: string) => { setEditTarget(null); setHighlightMessageId(null); setRepositoryId(undefined); setRepositoryMeta(null); setActiveThread(id); setDrawer(false); setSearch(""); };
  const chooseSearchResult = (id: string, messageId: string | null) => { chooseThread(id); setHighlightMessageId(messageId); };
  const newChat = () => { setEditTarget(null); setHighlightMessageId(null); setActiveThread(null); setMessages([]); setAttachments([]); setRepositoryId(undefined); setRepositoryMeta(null); setDrawer(false); };

  const downloadResponse = useCallback(async (message: Message) => {
    try {
      const uri = `${FileSystem.cacheDirectory || ""}swico-response-${message.id}.md`;
      await FileSystem.writeAsStringAsync(uri, message.content, { encoding: FileSystem.EncodingType.UTF8 });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: "text/markdown", UTI: "net.daringfireball.markdown" });
      else await Share.share({ message: message.content, title: "Swico response" });
    } catch (caught) { setError((caught as Error).message || "The response could not be downloaded."); }
  }, []);

  const pickDocument = useCallback(async () => {
    if (!user || !bootstrap?.features.web_attachments) return;
    const result = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
    if (result.canceled || !result.assets[0]) return;
    const file = result.assets[0];
    const limits = bootstrap.uploads;
    const extension = `.${file.name.split(".").pop()?.toLowerCase() || ""}`;
    const isImage = String(file.mimeType || "").startsWith("image/");
    const size = Number(file.size || 0);
    const currentFiles = attachments.filter(item => item.status === "ready");
    const currentBytes = currentFiles.reduce((sum, item) => sum + item.size_bytes, 0);
    const currentImages = currentFiles.filter(item => item.media_type.startsWith("image/")).length;
    const perFileLimit = isImage ? (limits.image_max_file_bytes || limits.max_file_bytes) : limits.max_file_bytes;
    if (!limits.supported_extensions.map(value => value.toLowerCase()).includes(extension)) { setError(`This file type is not supported. Use ${limits.supported_extensions.join(", ")}.`); return; }
    if (size <= 0 || size > perFileLimit) { setError("This file exceeds the configured upload limit."); return; }
    if (currentFiles.length >= limits.max_files_per_message || currentBytes + size > limits.max_total_bytes) { setError("The attachment limits for this message have been reached."); return; }
    if (isImage && (!limits.image_uploads_enabled || !bootstrap.features.web_image_uploads)) { setError("Image uploads are not enabled for this account."); return; }
    if (isImage && currentImages >= (limits.image_max_count || 4)) { setError(`You can attach up to ${limits.image_max_count || 4} images.`); return; }
    try {
      setUploading(true);
      const attachment = await uploadDocument(user, { uri: file.uri, name: file.name, type: file.mimeType || "application/octet-stream" }, progress => setError(progress < 100 ? `Uploading attachment · ${progress}%` : ""));
      setAttachments(value => [...value, { ...(attachment as Attachment), local_uri: isImage ? file.uri : undefined }]);
    } catch (caught) { setError((caught as Error).message || "Upload failed."); } finally { setUploading(false); }
  }, [attachments, bootstrap, user]);

  const removeRepository = useCallback(async () => {
    if (!repositoryId) return;
    const id = repositoryId;
    setRepositoryId(undefined);
    setRepositoryMeta(null);
    try { await deleteRepository(user!, id); } catch { setError("The repository was removed locally, but the server could not be reached."); }
  }, [repositoryId, user]);

  const saveAttachmentToKnowledge = useCallback(async (id: string) => {
    try { await approveKnowledge(user!, id); setAttachments(value => value.filter(item => item.id !== id)); }
    catch (caught) { setError((caught as Error).message || "The document could not be saved to Knowledge Library."); }
  }, [user]);

  const pickRepository = useCallback(async () => {
    if (!user || !bootstrap?.features.web_repository_upload || !bootstrap.repositories) return;
    const result = await DocumentPicker.getDocumentAsync({ type: "application/zip", copyToCacheDirectory: true });
    if (result.canceled || !result.assets[0]) return;
    const file = result.assets[0];
    if (!file.name.toLowerCase().endsWith(".zip")) { setError("Select a ZIP archive for the code repository."); return; }
    if (!file.size || file.size <= 0) { setError("The repository ZIP is empty."); return; }
    if (file.size > bootstrap.repositories.max_archive_bytes) { setError("The repository ZIP exceeds the configured upload limit."); return; }
    try {
      setUploading(true);
      const repository = await uploadRepository(user, { uri: file.uri, name: file.name, type: "application/zip" }, newSwicoRequestId(), progress => setError(progress < 100 ? `Uploading repository · ${progress}%` : ""));
      setRepositoryId(repository.id);
      setRepositoryMeta(repository);
    } catch (caught) { setError((caught as Error).message || "Repository upload failed."); } finally { setUploading(false); }
  }, [bootstrap, user]);

  const startDictation = useCallback(async () => {
    if (!user || !bootstrap?.features.web_voice_recording) return;
    if (bootstrap.assistant.tier === "free") { setError("Swico Free is text only. Switch to Swico Lite, Swico, or Swico Pro for voice."); return; }
    const permission = await Audio.requestPermissionsAsync();
    if (!permission.granted) { setError("Microphone permission is required for dictation."); return; }
    const recording = new Audio.Recording();
    try {
      await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await recording.startAsync();
      Alert.alert("Dictation", "Speak now, then press Stop.", [{ text: "Stop", onPress: async () => {
        await recording.stopAndUnloadAsync();
        const uri = recording.getURI();
        if (!uri) return;
        const result = await transcribeAudioUri(user, { uri, name: "recording.m4a", type: "audio/mp4" }, newSwicoRequestId(), newSwicoRequestId(), bootstrap.user.reply_language);
        setDraft(value => `${value}${value ? " " : ""}${result.transcript}`);
        void FileSystem.deleteAsync(uri, { idempotent: true });
      }}]);
    } catch { setError("The microphone could not start."); }
  }, [bootstrap, user]);

  const openRealtimeVoice = useCallback(() => {
    if (!bootstrap || !bootstrap.features.web_realtime_voice || !realtimePcmAvailable()) {
      setError(Platform.OS === "android" ? "Realtime Voice is not enabled for this account." : "Realtime Voice is currently available on Android only.");
      return;
    }
    if (bootstrap.assistant.tier === "free") { setError("Swico Free is text only. Switch tiers for Voice Mode."); return; }
    setRealtimeVoice(true);
  }, [bootstrap]);

  const logicalMessages = useMemo(() => {
    const visible = messages.filter(item => !item.is_continuation_control);
    const continuationIds = new Set(visible.filter(item => item.continuation_root_message_id).map(item => item.id));
    return visible.flatMap(item => {
      if (continuationIds.has(item.id)) return [];
      if (item.role !== "assistant") return [item];
      const children = visible.filter(candidate => candidate.role === "assistant" && candidate.continuation_root_message_id === item.id).sort((a, b) => Number(a.continuation_segment_index || 0) - Number(b.continuation_segment_index || 0));
      if (!children.length) return [{ ...item, content: continuationMarkdown(item.content, item.continuation_render_prefix) }];
      const last = children[children.length - 1];
      return [{ ...last, content: stitchContinuationMarkdown([item, ...children]), sources: last.sources?.length ? last.sources : item.sources, quality: last.quality || item.quality }];
    });
  }, [messages]);
  if (!user || !bootstrap) return <Screen glow={false}><View style={styles.loading}><ActivityIndicator color={t.accent} /><Text style={styles.muted}>Loading Swico...</Text></View></Screen>;
  const activeTitle = threads.find(item => item.id === activeThread)?.title || "New chat";
  return (
    <Screen safeArea={false} glow={false}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <Pressable onPress={() => setDrawer(true)} style={styles.iconButton} accessibilityLabel="Open chat drawer"><Ionicons name="menu" size={24} color={t.text} /></Pressable>
          <View style={styles.headerCenter}><Text style={styles.brand}>Swico</Text><Text style={styles.threadTitle} numberOfLines={1}>{activeTitle}</Text></View>
          <Pressable onPress={() => setSettingsModal(true)} style={styles.iconButton} accessibilityLabel="Open settings"><Ionicons name="settings-outline" size={21} color={t.text} /></Pressable>
        </View>
        <View style={styles.balance}><Text style={styles.balanceText}>{bootstrap.wallets?.chat?.balance_display === "Unlimited" ? "Unlimited" : `${bootstrap.wallets?.chat?.available_micros ?? bootstrap.wallet.available_micros} credits available`}</Text><Text style={styles.tierText}>{bootstrap.assistant.tier_label}</Text></View>
        {stream.phase === "queued" || stream.phase === "starting" ? <View style={styles.queueBanner}><Ionicons name="time-outline" color={t.accent} size={16} /><Text style={styles.queueText}>{stream.phase === "starting" ? "Starting..." : `Waiting · position ${stream.queuePosition ?? "—"}${stream.estimatedWaitSeconds ? ` · ~${stream.estimatedWaitSeconds}s` : ""}`}</Text></View> : null}
        {error ? <Pressable onPress={() => setError("")} style={styles.errorBanner}><Text style={styles.errorText}>{error}</Text></Pressable> : null}
        {logicalMessages.length === 0 ? <View style={styles.empty}><Text style={styles.emptyTitle}>How can Swico help?</Text><Text style={styles.emptyText}>Ask a question, upload a document, or continue a conversation from the web.</Text></View> : <FlatList ref={listRef} data={logicalMessages} keyExtractor={item => item.id} contentContainerStyle={styles.messages} renderItem={({ item }) => <MessageRow message={item} highlighted={item.id === highlightMessageId} onCopy={() => void Clipboard.setStringAsync(item.content)} onShare={() => void Share.share({ message: item.content })} onDownload={() => void downloadResponse(item)} onOpenEditor={() => setEditorMessage(item)} onEditResponse={() => setEditorMessage(item)} onVoice={() => void playVoice(item)} onFeedback={rating => void sendFeedback(user, item.id, rating)} onContinue={() => void send(undefined, { continueId: item.id })} onRegenerate={() => { const original = messages.find(candidate => candidate.role === "user" && candidate.request_id === item.request_id); if (original) void send(original.content, { regenerateId: item.id }); }} onEdit={() => { setDraft(item.content); setEditTarget(item.id); }} />} />}
        {attachments.length || repositoryId ? <View style={styles.attachmentBar}>{attachments.map(item => <View key={item.id} style={styles.chip}>{item.local_uri ? <Image source={{ uri: item.local_uri }} style={{ width: 28, height: 28, borderRadius: 5 }} /> : null}<View><Text style={styles.chipText} numberOfLines={1}>{item.name}</Text><Text style={styles.attachmentMeta}>{item.status === "expired" ? "Expired" : item.warnings?.[0] || "Ready"}</Text></View>{bootstrap.features.web_knowledge_library ? <Pressable onPress={() => void saveAttachmentToKnowledge(item.id)} accessibilityLabel="Save document to Knowledge Library"><Ionicons name="bookmark-outline" size={14} color={t.accent} /></Pressable> : null}<Pressable onPress={() => { setAttachments(value => value.filter(entry => entry.id !== item.id)); void deleteUpload(user, item.id); }}><Ionicons name="close" size={14} color={t.text} /></Pressable></View>)}{repositoryId ? <View style={styles.chip}><View><Text style={styles.chipText}>{repositoryMeta?.display_name || "Repository ready"}</Text><Text style={styles.attachmentMeta}>{repositoryMeta ? `${repositoryMeta.status} · ${repositoryMeta.file_count} files${repositoryMeta.languages?.length ? ` · ${repositoryMeta.languages.slice(0, 3).join(", ")}` : ""}` : "Ready"}</Text></View><Pressable onPress={() => void removeRepository()}><Ionicons name="close" size={14} color={t.text} /></Pressable></View> : null}</View> : null}
        <View style={[styles.composerShell, styles.composerSurface, { paddingBottom: Math.max(insets.bottom, 10) }]}>
          <View style={styles.composerTools}><Pressable onPress={pickDocument} accessibilityLabel="Attach file"><Ionicons name="add-circle-outline" size={25} color={t.accent} /></Pressable><Pressable onPress={pickRepository} accessibilityLabel="Attach repository"><Ionicons name="logo-github" size={21} color={t.accent} /></Pressable><Pressable onPress={() => void startDictation()} accessibilityLabel="Dictate"><Ionicons name="mic-outline" size={23} color={t.accent} /></Pressable><Pressable onPress={openRealtimeVoice} accessibilityLabel="Realtime voice"><Ionicons name="radio-outline" size={21} color={t.accent} /></Pressable><Pressable onPress={() => setTierModal(true)} style={styles.tierPill}><Text style={styles.tierPillText}>{bootstrap.assistant.tier_label}</Text><Ionicons name="chevron-down" size={14} color={t.accent} /></Pressable></View>
          {bootstrap.uploads.long_input_enabled && draft.length > (bootstrap.uploads.long_input_inline_threshold_chars || 16000) ? <View style={styles.longInputRow}><Text style={styles.attachmentMeta}>Large text action</Text>{(["summarize", "analyze", "ask_questions", "rewrite", "translate"] as const).map(mode => <Pressable key={mode} onPress={() => setLongInputMode(mode)} style={[styles.modePill, longInputMode === mode && styles.modePillSelected]}><Text style={styles.modeText}>{mode.replace("_", " ")}</Text></Pressable>)}</View> : null}
          <TextInput testID="chat-input" value={draft} onChangeText={setDraft} placeholder="Message Swico" placeholderTextColor={t.muted} multiline maxLength={bootstrap.uploads.long_input_enabled ? (bootstrap.uploads.long_input_max_chars || 64000) : 16000} style={styles.input} editable={!streaming && !uploading} onSubmitEditing={() => void send()} blurOnSubmit={false} />
          <Pressable testID="chat-send-button" accessibilityLabel={streaming ? "Stop generation" : "Send message"} onPress={() => streaming ? void stop() : void send()} disabled={uploading || (!streaming && !draft.trim())} style={[styles.sendButton, (uploading || (!streaming && !draft.trim())) && styles.sendDisabled]}><Ionicons name={streaming ? "stop" : "arrow-up"} size={20} color={t.accentText} /></Pressable>
        </View>
      </KeyboardAvoidingView>
      <Drawer visible={drawer} onClose={() => setDrawer(false)} threads={threads} hasMore={hasMoreThreads} onLoadMore={() => void loadMoreThreads()} archived={archived} setArchived={value => { setArchived(value); void reloadThreads(value); }} active={activeThread} onSelect={chooseThread} onSelectSearch={chooseSearchResult} onNew={newChat} onActions={threadAction} search={search} setSearch={setSearch} results={searchResults} onSignOut={() => void signOutUser()} />
      <TierModal visible={tierModal} onClose={() => setTierModal(false)} bootstrap={bootstrap} onChoose={async tier => { try { const assistant = await updateAssistant(user, tier); setBootstrap(value => value ? { ...value, assistant } : value); setTierModal(false); } catch (caught) { setError((caught as Error).message); } }} />
      <SettingsModal visible={settingsModal} onClose={() => setSettingsModal(false)} user={user} bootstrap={bootstrap} onBootstrap={setBootstrap} />
      <RealtimeVoiceModal visible={realtimeVoice} onClose={() => setRealtimeVoice(false)} user={user} threadId={activeThread} onRefresh={() => { if (activeThread) void reloadMessages(activeThread); void reloadThreads(false); }} />
      <ResponseEditorModal message={editorMessage} onClose={() => setEditorMessage(null)} onApply={(content) => { if (!editorMessage) return; setMessages(value => value.map(item => item.id === editorMessage.id ? { ...item, content } : item)); setEditorMessage(value => value ? { ...value, content } : value); }} />
      <Modal visible={Boolean(renameTarget)} transparent animationType="fade" onRequestClose={() => setRenameTarget(null)}><View style={styles.modalScrim}><View style={styles.renameCard}><Text style={styles.sheetTitle}>Rename chat</Text><TextInput autoFocus value={renameTitle} onChangeText={setRenameTitle} style={styles.settingsInput} placeholder="Chat name" placeholderTextColor={t.muted} /><View style={styles.renameActions}><Pressable onPress={() => setRenameTarget(null)}><Text style={styles.tab}>Cancel</Text></Pressable><Pressable onPress={() => void saveRename()} style={styles.saveButton}><Text style={styles.saveText}>Save</Text></Pressable></View></View></View></Modal>
    </Screen>
  );
}

function MessageRow({ message, highlighted, onCopy, onShare, onDownload, onOpenEditor, onEditResponse, onVoice, onFeedback, onContinue, onRegenerate, onEdit }: { message: Message; highlighted?: boolean; onCopy: () => void; onShare: () => void; onDownload: () => void; onOpenEditor: () => void; onEditResponse: () => void; onVoice: () => void; onFeedback: (rating: "up" | "down") => void; onContinue: () => void; onRegenerate: () => void; onEdit: () => void }) {
  const { palette: t } = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const assistant = message.role === "assistant";
  return <View style={[styles.messageRow, assistant ? styles.assistantRow : styles.userRow]}><View style={[styles.messageCard, assistant ? styles.assistantCard : styles.userCard, highlighted && { borderColor: t.accent, borderWidth: 2 }]}>{assistant ? <MarkdownText value={message.content || "…"} /> : <Text style={styles.userText}>{message.content}</Text>}{assistant && message.sources?.length ? <SourcesPanel sources={message.sources} /> : null}{assistant && message.quality ? <QualityPanel quality={message.quality} /> : null}{message.truncated && message.can_continue ? <Pressable onPress={onContinue} style={styles.continueButton}><Text style={styles.continueText}>Continue generating</Text></Pressable> : null}<View style={styles.messageActions}><Pressable onPress={onCopy} accessibilityLabel="Copy message"><Ionicons name="copy-outline" size={16} color={t.muted} /></Pressable>{assistant ? <><Pressable onPress={onEditResponse} accessibilityLabel="Edit response"><Ionicons name="pencil-outline" size={16} color={t.muted} /></Pressable><Pressable onPress={onDownload} accessibilityLabel="Download response"><Ionicons name="download-outline" size={16} color={t.muted} /></Pressable><Pressable onPress={onOpenEditor} accessibilityLabel="Open response editor"><Ionicons name="reader-outline" size={16} color={t.muted} /></Pressable><Pressable onPress={onShare} accessibilityLabel="Share response"><Ionicons name="share-outline" size={16} color={t.muted} /></Pressable><Pressable onPress={onVoice}><Ionicons name="volume-medium-outline" size={16} color={t.muted} /></Pressable><Pressable onPress={onRegenerate}><Ionicons name="refresh-outline" size={16} color={t.muted} /></Pressable><Pressable onPress={() => onFeedback("up")}><Ionicons name="thumbs-up-outline" size={16} color={t.muted} /></Pressable><Pressable onPress={() => onFeedback("down")}><Ionicons name="thumbs-down-outline" size={16} color={t.muted} /></Pressable></> : <Pressable onPress={onEdit}><Ionicons name="create-outline" size={16} color={t.muted} /></Pressable>}</View></View></View>;
}

function SourcesPanel({ sources }: { sources: NonNullable<Message["sources"]> }) {
  const { palette: t } = useAppTheme();
  return <View style={{ marginTop: 10, gap: 4 }}><Text style={{ color: t.text, fontSize: 12, fontWeight: "800" }}>Sources</Text>{sources.map(source => <Text key={`${source.id}-${source.locator}`} style={{ color: t.muted, fontSize: 11 }} numberOfLines={2}>{source.id} · {source.label} · {source.locator}</Text>)}</View>;
}

function QualityPanel({ quality }: { quality: NonNullable<Message["quality"]> }) {
  const { palette: t } = useAppTheme();
  const warning = quality.status === "unverified" || quality.status === "insufficient_evidence" || quality.checks.some(check => ["failed", "warning", "error"].includes(check.status));
  return <View style={{ marginTop: 9, flexDirection: "row", alignItems: "center", gap: 5 }}><Ionicons name={warning ? "alert-circle-outline" : "shield-checkmark-outline"} size={14} color={warning ? t.danger : t.text} /><Text style={{ color: warning ? t.danger : t.muted, fontSize: 11 }}>{quality.status.replace(/_/g, " ")}</Text></View>;
}

function ResponseEditorModal({ message, onClose, onApply }: { message: Message | null; onClose: () => void; onApply: (content: string) => void }) {
  const { palette: t } = useAppTheme();
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [draft, setDraft] = useState("");
  useEffect(() => { if (message) { setDraft(message.content); setMode("preview"); } }, [message]);
  return <Modal visible={Boolean(message)} transparent animationType="slide" onRequestClose={onClose}><View style={{ flex: 1, backgroundColor: t.overlay, justifyContent: "flex-end" }}><View style={{ maxHeight: "92%", backgroundColor: t.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18, gap: 12 }}><View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}><Text style={{ color: t.text, fontSize: 20, fontWeight: "800" }}>Response editor</Text><Pressable onPress={onClose}><Ionicons name="close" size={22} color={t.text} /></Pressable></View><View style={{ flexDirection: "row", gap: 8 }}><Pressable onPress={() => setMode("preview")} style={[stylesEditor.tab, { backgroundColor: mode === "preview" ? t.accent : t.soft }]}><Text style={{ color: mode === "preview" ? t.accentText : t.text }}>Preview</Text></Pressable><Pressable onPress={() => setMode("source")} style={[stylesEditor.tab, { backgroundColor: mode === "source" ? t.accent : t.soft }]}><Text style={{ color: mode === "source" ? t.accentText : t.text }}>Markdown source</Text></Pressable></View>{mode === "source" ? <TextInput multiline value={draft} onChangeText={setDraft} style={{ minHeight: 250, color: t.text, backgroundColor: t.soft, borderRadius: 10, padding: 12, textAlignVertical: "top" }} /> : <ScrollView style={{ minHeight: 250 }}><MarkdownText value={draft} /></ScrollView>}<View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 10 }}><Pressable onPress={() => message && setDraft(message.content)}><Text style={{ color: t.muted, padding: 10 }}>Reset</Text></Pressable><Pressable onPress={() => { onApply(draft); onClose(); }} style={[stylesEditor.apply, { backgroundColor: t.accent }]}><Text style={{ color: t.accentText, fontWeight: "800" }}>Apply changes</Text></Pressable></View></View></View></Modal>;
}

const stylesEditor = StyleSheet.create({ tab: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8 }, apply: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 9 } });

function RealtimeVoiceModal({ visible, onClose, user, threadId, onRefresh }: { visible: boolean; onClose: () => void; user: NonNullable<ReturnType<typeof useAuth>["user"]>; threadId: string | null; onRefresh: () => void }) {
  const { palette: t } = useAppTheme();
  const [phase, setPhase] = useState("connecting");
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState("");
  const transportRef = useRef<SwicoRealtimeVoiceTransport | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const audioUriRef = useRef<string | null>(null);
  const audioChunksRef = useRef<Uint8Array[]>([]);
  const audioCodecRef = useRef("mp3");
  const playAudio = useCallback(async () => {
    if (audioCodecRef.current !== "mp3" || !audioChunksRef.current.length) return;
    const bytes = new Uint8Array(audioChunksRef.current.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0; audioChunksRef.current.forEach(chunk => { bytes.set(chunk, offset); offset += chunk.byteLength; });
    let binary = ""; bytes.forEach(value => { binary += String.fromCharCode(value); });
    const uri = `${FileSystem.cacheDirectory || ""}swico-voice-${Date.now()}.mp3`;
    await FileSystem.writeAsStringAsync(uri, globalThis.btoa(binary), { encoding: FileSystem.EncodingType.Base64 });
    audioUriRef.current = uri;
    await soundRef.current?.unloadAsync().catch(() => undefined);
    const loaded = await Audio.Sound.createAsync({ uri }, { shouldPlay: true });
    soundRef.current = loaded.sound;
  }, []);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    void createVoiceSession(user, { browser_capabilities: { web_audio: false, media_source: false, media_source_mp3: false } }).then(async session => {
      if (!alive) return;
      const transport = new SwicoRealtimeVoiceTransport(session, { onJson: message => {
        if (!alive) return;
        if (message.type === "state.changed") setPhase(String(message.state || "listening"));
        if (message.type === "session.ready") setPhase("listening");
        if (message.type === "audio.start") { audioChunksRef.current = []; audioCodecRef.current = String(message.codec || "mp3"); setPhase("speaking"); }
        if (message.type === "audio.end") { void playAudio().catch(caught => setError((caught as Error).message || "Voice audio could not be played.")); }
        if (message.type === "turn.done") { setPhase("listening"); onRefresh(); }
        if (message.type === "error") setError(String(message.message || "Realtime Voice stopped safely."));
      }, onAudio: packet => { if (packet.byteLength > 4) audioChunksRef.current.push(new Uint8Array(packet.slice(4))); }, onError: message => alive && setError(message), onClose: () => alive && setPhase("closed") });
      transportRef.current = transport;
      try { await transport.connect(threadId || undefined); } catch (caught) { if (alive) setError((caught as Error).message || "Realtime Voice could not start."); }
    }).catch(caught => alive && setError((caught as Error).message || "Realtime Voice could not start."));
    return () => { alive = false; void transportRef.current?.close(); transportRef.current = null; void soundRef.current?.unloadAsync().catch(() => undefined); if (audioUriRef.current) void FileSystem.deleteAsync(audioUriRef.current, { idempotent: true }); void endVoiceSession(user).catch(() => undefined); };
  }, [onRefresh, playAudio, threadId, user, visible]);
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}><View style={{ flex: 1, backgroundColor: t.overlay, justifyContent: "flex-end" }}><View style={{ backgroundColor: t.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 24, gap: 16 }}><View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}><Text style={{ color: t.text, fontSize: 21, fontWeight: "800" }}>Voice Mode</Text><Pressable onPress={onClose}><Ionicons name="close" size={22} color={t.text} /></Pressable></View><Text style={{ color: t.muted, textAlign: "center" }}>{error || phase.replace(/_/g, " ")}</Text><View style={{ alignItems: "center", paddingVertical: 20 }}><Ionicons name={muted ? "mic-off" : "mic"} size={54} color={t.accent} /></View><View style={{ flexDirection: "row", justifyContent: "center", gap: 14 }}><Pressable onPress={() => { const next = !muted; setMuted(next); transportRef.current?.mute(next); }} style={{ padding: 12, borderRadius: 12, backgroundColor: t.soft }}><Text style={{ color: t.text }}>{muted ? "Unmute" : "Mute"}</Text></Pressable><Pressable onPress={onClose} style={{ padding: 12, borderRadius: 12, backgroundColor: t.accent }}><Text style={{ color: t.accentText, fontWeight: "800" }}>End Voice</Text></Pressable></View></View></View></Modal>;
}

function Drawer({ visible, onClose, threads, hasMore, onLoadMore, active, onSelect, onSelectSearch, onNew, onActions, archived, setArchived, search, setSearch, results, onSignOut }: { visible: boolean; onClose: () => void; threads: Thread[]; hasMore: boolean; onLoadMore: () => void; active: string | null; onSelect: (id: string) => void; onSelectSearch: (id: string, messageId: string | null) => void; onNew: () => void; onActions: (thread: Thread) => void; archived: boolean; setArchived: (value: boolean) => void; search: string; setSearch: (value: string) => void; results: { thread_id: string | null; message_id: string | null; snippet: string }[]; onSignOut: () => void }) {
  const { palette: t } = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  return <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}><View style={styles.modalScrim}><View style={styles.drawer}><View style={styles.drawerHeader}><Text style={styles.drawerTitle}>Swico</Text><Pressable onPress={onClose}><Ionicons name="close" size={24} color={t.ink} /></Pressable></View><Pressable onPress={onNew} style={styles.newChat}><Ionicons name="add" size={20} color={t.accentText} /><Text style={styles.newChatText}>New chat</Text></Pressable><TextInput value={search} onChangeText={setSearch} placeholder="Search chats" placeholderTextColor={t.muted} style={styles.searchInput} />{results.length ? <View>{results.map(item => <Pressable key={`${item.thread_id}-${item.message_id}`} onPress={() => item.thread_id && onSelectSearch(item.thread_id, item.message_id)} style={styles.searchResult}><Text style={styles.threadText}>{item.snippet}</Text></Pressable>)}</View> : null}<View style={styles.archiveTabs}><Pressable onPress={() => setArchived(false)}><Text style={!archived ? styles.activeTab : styles.tab}>Chats</Text></Pressable><Pressable onPress={() => setArchived(true)}><Text style={archived ? styles.activeTab : styles.tab}>Archived</Text></Pressable></View><ScrollView style={styles.threadList}>{threads.map(thread => <View key={thread.id} style={[styles.threadItem, thread.id === active && styles.threadActive]}><Pressable onPress={() => onSelect(thread.id)} style={styles.threadMain}><Ionicons name="chatbubble-outline" size={17} color={t.muted} /><Text style={styles.threadText} numberOfLines={1}>{thread.title || "New chat"}</Text></Pressable><Pressable onPress={() => onActions(thread)} accessibilityLabel={`Actions for ${thread.title || "chat"}`}><Ionicons name="ellipsis-horizontal" size={18} color={t.muted} /></Pressable></View>)}{hasMore ? <Pressable onPress={onLoadMore} style={styles.loadMore}><Text style={styles.closeText}>Load more</Text></Pressable> : null}</ScrollView><Pressable onPress={onSignOut} style={styles.signOut}><Ionicons name="log-out-outline" size={18} color={t.danger} /><Text style={styles.signOutText}>Sign out</Text></Pressable></View></View></Modal>;
}

function TierModal({ visible, onClose, bootstrap, onChoose }: { visible: boolean; onClose: () => void; bootstrap: Bootstrap; onChoose: (tier: string) => Promise<void> }) {
  const { palette: t } = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}><View style={styles.modalScrim}><View style={styles.sheet}><Text style={styles.sheetTitle}>Swico mode</Text>{bootstrap.assistant.tiers.map(option => <Pressable key={option.id} disabled={!option.available || option.selected} onPress={() => void onChoose(option.id)} style={[styles.tierOption, option.selected && styles.tierSelected, !option.available && styles.tierUnavailable]}><View style={styles.tierOptionText}><Text style={styles.tierLabel}>{option.label}</Text><Text style={styles.tierDescription}>{option.description}</Text></View>{option.selected ? <Ionicons name="checkmark-circle" size={22} color={t.caramel} /> : null}</Pressable>)}<Pressable onPress={onClose} style={styles.closeSheet}><Text style={styles.closeText}>Close</Text></Pressable></View></View></Modal>;
}

function SettingsModal({ visible, onClose, user, bootstrap, onBootstrap }: { visible: boolean; onClose: () => void; user: NonNullable<ReturnType<typeof useAuth>["user"]>; bootstrap: Bootstrap; onBootstrap: React.Dispatch<React.SetStateAction<Bootstrap | null>> }) {
  const { palette: t, themePreference, setThemePreference } = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [profile, setProfile] = useState<ProfileSettings | null>(null);
  const [settingsError, setSettingsError] = useState("");
  const [memoryEnabled, setMemoryEnabled] = useState(false);
  const [memoryItems, setMemoryItems] = useState<MemoryFact[]>([]);
  const [knowledgeDocs, setKnowledgeDocs] = useState<KnowledgeDocument[]>([]);
  const [usage, setUsage] = useState<{ request_count?: number; debited_ai_credits?: string } | null>(null);
  const [usageSettings, setUsageSettings] = useState<Record<string, unknown> | null>(null);
  const [ledgerItems, setLedgerItems] = useState<unknown[]>([]);
  const [paymentItems, setPaymentItems] = useState<unknown[]>([]);
  const [knowledgeJobs, setKnowledgeJobs] = useState<Record<string, string>>({});
  const [accountCounts, setAccountCounts] = useState({ knowledge: 0, ledger: 0, payments: 0 });
  useEffect(() => {
    if (!visible) return;
    setSettingsError("");
    void Promise.all([getProfileSettings(user), getMemorySettings(user), getUsage(user), getUsageSettings(user)]).then(([nextProfile, memory, nextUsage, nextUsageSettings]) => {
      setProfile(nextProfile); setMemoryEnabled(memory.enabled); setMemoryItems(memory.items || []); setUsage(nextUsage);
      setUsageSettings(nextUsageSettings);
    }).catch(() => undefined);
    const knowledgeRequest = bootstrap.features.web_knowledge_library ? listKnowledge(user) : Promise.resolve({ items: [] });
    void Promise.all([knowledgeRequest, getLedger(user), getPayments(user)]).then(([knowledge, ledger, payments]) => {
      setKnowledgeDocs(knowledge.items); setLedgerItems(ledger.items); setPaymentItems(payments.items); setAccountCounts({ knowledge: knowledge.items.length, ledger: ledger.items.length, payments: payments.items.length });
    }).catch(() => undefined);
  }, [bootstrap.features.web_knowledge_library, user, visible]);
  const pollKnowledge = useCallback(async (documentId: string) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const result = await getKnowledgeJobStatus(user, documentId);
      const status = String(result.job.status || "unknown");
      setKnowledgeJobs(value => ({ ...value, [documentId]: status }));
      if (["completed", "complete", "failed", "cancelled", "error"].includes(status.toLowerCase())) return;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }, [user]);
  const startKnowledgeReindex = useCallback(async (documentId: string) => {
    setSettingsError("");
    try { await reindexKnowledge(user, documentId); await pollKnowledge(documentId); }
    catch (caught) { setSettingsError((caught as Error).message || "Knowledge indexing could not start."); }
  }, [pollKnowledge, user]);
  const stopKnowledgeReindex = useCallback(async (documentId: string) => {
    try { const result = await cancelKnowledgeJob(user, documentId); setKnowledgeJobs(value => ({ ...value, [documentId]: result.job.status })); }
    catch (caught) { setSettingsError((caught as Error).message || "Knowledge indexing could not be cancelled."); }
  }, [user]);
  return <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}><View style={styles.modalScrim}><View style={styles.settings}><View style={styles.drawerHeader}><Text style={styles.sheetTitle}>Settings</Text><Pressable onPress={onClose}><Ionicons name="close" size={24} color={t.ink} /></Pressable></View><ScrollView contentContainerStyle={styles.settingsContent}>{settingsError ? <Text style={styles.errorText}>{settingsError}</Text> : null}{profile ? <><Text style={styles.sectionTitle}>Profile</Text><TextInput value={profile.name} onChangeText={value => setProfile({ ...profile, name: value })} style={styles.settingsInput} placeholder="Name" placeholderTextColor={t.muted} /><TextInput value={profile.place || ""} onChangeText={value => setProfile({ ...profile, place: value })} style={styles.settingsInput} placeholder="Place" placeholderTextColor={t.muted} /><TextInput value={profile.timezone} onChangeText={value => setProfile({ ...profile, timezone: value })} style={styles.settingsInput} placeholder="Timezone" placeholderTextColor={t.muted} /><TextInput value={profile.assistant_name} onChangeText={value => setProfile({ ...profile, assistant_name: value })} style={styles.settingsInput} placeholder="Assistant name" placeholderTextColor={t.muted} /><View style={{ flexDirection: "row", gap: 8 }}>{(["en", "ta"] as const).map(language => <Pressable key={language} onPress={() => setProfile({ ...profile, reply_language: language })} style={[styles.modePill, profile.reply_language === language && styles.modePillSelected]}><Text style={styles.modeText}>{language === "ta" ? "தமிழ்" : "English"}</Text></Pressable>)}</View><Text style={styles.settingsMeta}>{profile.email || bootstrap.user.email || ""} · managed by Firebase</Text><Pressable onPress={async () => { if (!profile) return; try { const saved = await updateProfileSettings(user, { name: profile.name, place: profile.place, timezone: profile.timezone, assistant_name: profile.assistant_name, reply_language: profile.reply_language }); setProfile(saved); } catch (caught) { setSettingsError((caught as Error).message); } }} style={styles.saveButton}><Text style={styles.saveText}>Save profile</Text></Pressable></> : null}<Text style={styles.sectionTitle}>General</Text><Text style={styles.settingsMeta}>Current tier: {bootstrap.assistant.tier_label}</Text><Text style={styles.settingsMeta}>Theme</Text><View style={{ flexDirection: "row", gap: 8 }}>{(["system", "light", "dark"] as const).map(mode => <Pressable key={mode} onPress={() => void setThemePreference(mode)} style={[styles.modePill, themePreference === mode && styles.modePillSelected]}><Text style={styles.modeText}>{mode}</Text></Pressable>)}</View><Text style={styles.sectionTitle}>Usage & wallet</Text><Text style={styles.settingsMeta}>{usage?.request_count ?? 0} requests · {usage?.debited_ai_credits ?? "0"} AI credits used</Text><Text style={styles.settingsMeta}>{bootstrap.wallets?.chat.available_micros ?? bootstrap.wallet.available_micros} chat-credit balance</Text><Text style={styles.settingsMeta}>{bootstrap.wallets?.voice.available_micros ?? 0} voice-credit balance</Text>{usageSettings ? <Text style={styles.settingsMeta}>Usage preferences: {String(usageSettings.warning_threshold_percent ?? "default")} % warning · {String(usageSettings.next_reset_at || "server reset")}</Text> : null}<Text style={styles.settingsMeta}>Payment history: {paymentItems.length} records · ledger: {ledgerItems.length} records</Text><Text style={styles.sectionTitle}>Memory</Text><Pressable onPress={async () => { try { const next = await updateMemorySettings(user, !memoryEnabled); setMemoryEnabled(next.enabled); } catch (caught) { setSettingsError((caught as Error).message); } }} style={styles.settingRow}><Text style={styles.settingLabel}>Cross-chat memory</Text><Text style={styles.settingValue}>{memoryEnabled ? "On" : "Off"}</Text></Pressable>{memoryItems.map(fact => <View key={fact.id} style={styles.settingRow}><View style={{ flex: 1 }}><Text style={styles.settingLabel}>{fact.category.replace(/_/g, " ")}</Text><Text style={styles.settingsMeta}>{fact.value_text}</Text></View><Pressable onPress={() => void deleteMemory(user, fact.id).then(() => setMemoryItems(value => value.filter(item => item.id !== fact.id))).catch(caught => setSettingsError((caught as Error).message))}><Ionicons name="trash-outline" size={17} color={t.danger} /></Pressable></View>)}{memoryItems.length ? <Pressable onPress={() => void deleteMemory(user).then(() => setMemoryItems([])).catch(caught => setSettingsError((caught as Error).message))} style={styles.settingRow}><Text style={styles.settingLabel}>Delete all memory</Text></Pressable> : null}<Text style={styles.sectionTitle}>Knowledge & data</Text><Text style={styles.settingsMeta}>{accountCounts.knowledge} knowledge documents · {accountCounts.ledger} ledger entries · {accountCounts.payments} payments</Text>{knowledgeDocs.map(document => <View key={document.id} style={styles.settingRow}><View style={{ flex: 1 }}><Text style={styles.settingLabel}>{document.title}</Text><Text style={styles.settingsMeta}>{document.status} · {document.chunk_count} chunks{knowledgeJobs[document.id] ? ` · job ${knowledgeJobs[document.id]}` : ""}</Text></View>{knowledgeJobs[document.id] && !["completed", "complete", "failed", "cancelled", "error"].includes(knowledgeJobs[document.id].toLowerCase()) ? <Pressable onPress={() => void stopKnowledgeReindex(document.id)}><Ionicons name="stop-circle-outline" size={17} color={t.danger} /></Pressable> : <Pressable onPress={() => void startKnowledgeReindex(document.id)}><Ionicons name="refresh" size={17} color={t.accent} /></Pressable>}<Pressable onPress={() => void deleteKnowledge(user, document.id).then(() => setKnowledgeDocs(value => value.filter(item => item.id !== document.id))).catch(caught => setSettingsError((caught as Error).message))}><Ionicons name="trash-outline" size={17} color={t.danger} /></Pressable></View>)}<Pressable onPress={async () => { try { onBootstrap(await getBootstrap(user)); } catch (caught) { setSettingsError((caught as Error).message); } }} style={styles.settingRow}><Text style={styles.settingLabel}>Refresh account data</Text><Ionicons name="refresh" size={18} color={t.caramel} /></Pressable><Pressable onPress={onClose} style={styles.closeSheet}><Text style={styles.closeText}>Done</Text></Pressable></ScrollView></View></View></Modal>;
}

function createStyles(t: Palette) { return StyleSheet.create({
  composerSurface: { backgroundColor: t.composer }, drawerSurface: { backgroundColor: t.sidebar },
  loadMore: { alignItems: "center", paddingVertical: 12 }, attachmentMeta: { color: t.muted, fontSize: 10, marginTop: 2 }, longInputRow: { flexDirection: "row", alignItems: "center", gap: 5, flexWrap: "wrap", marginBottom: 6 }, modePill: { borderRadius: 8, paddingHorizontal: 6, paddingVertical: 4, backgroundColor: t.soft }, modePillSelected: { backgroundColor: t.accent }, modeText: { color: t.text, fontSize: 10, textTransform: "capitalize" },
  fill: { flex: 1 }, loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }, muted: { color: t.muted }, header: { minHeight: 62, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderBottomColor: t.line }, iconButton: { width: 42, height: 42, alignItems: "center", justifyContent: "center" }, headerCenter: { flex: 1, alignItems: "center" }, brand: { color: t.ink, fontSize: 20, fontWeight: "900" }, threadTitle: { color: t.muted, fontSize: 11, maxWidth: 190 }, balance: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 18, paddingVertical: 7 }, balanceText: { color: t.muted, fontSize: 11 }, tierText: { color: t.caramel, fontSize: 11, fontWeight: "800" }, queueBanner: { marginHorizontal: 14, borderRadius: 12, backgroundColor: t.accentSoft, padding: 9, flexDirection: "row", alignItems: "center", gap: 7 }, queueText: { color: t.caramel, fontSize: 12, fontWeight: "700" }, errorBanner: { margin: 12, padding: 10, borderRadius: 10, backgroundColor: "rgba(255, 138, 138, 0.16)" }, errorText: { color: t.danger, fontSize: 12 }, empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 38 }, emptyTitle: { color: t.ink, fontSize: 28, fontWeight: "900", textAlign: "center" }, emptyText: { color: t.muted, textAlign: "center", lineHeight: 21, marginTop: 10 }, messages: { padding: 14, gap: 12, paddingBottom: 22 }, messageRow: { width: "100%" }, assistantRow: { alignItems: "flex-start" }, userRow: { alignItems: "flex-end" }, messageCard: { maxWidth: "90%", borderRadius: 18, padding: 13 }, assistantCard: { backgroundColor: t.raised, borderWidth: 1, borderColor: t.line }, userCard: { backgroundColor: t.accent }, userText: { color: t.accentText, fontSize: 15, lineHeight: 23 }, sourceText: { color: t.caramel, fontSize: 11, marginTop: 10 }, messageActions: { flexDirection: "row", gap: 15, marginTop: 12 }, continueButton: { marginTop: 12, padding: 9, borderRadius: 9, backgroundColor: t.accentSoft }, continueText: { color: t.caramel, fontWeight: "800", fontSize: 12 }, attachmentBar: { flexDirection: "row", gap: 7, paddingHorizontal: 14, paddingVertical: 5, flexWrap: "wrap" }, chip: { flexDirection: "row", alignItems: "center", gap: 5, maxWidth: 180, backgroundColor: t.soft, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 6 }, chipText: { color: t.text, fontSize: 11 }, composerShell: { borderTopWidth: 1, borderTopColor: t.line, paddingHorizontal: 13, paddingTop: 8, backgroundColor: t.glassStrong }, composerTools: { flexDirection: "row", alignItems: "center", gap: 16, marginBottom: 7 }, tierPill: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 3, borderWidth: 1, borderColor: t.lineStrong, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 5 }, tierPillText: { color: t.caramel, fontSize: 11, fontWeight: "800" }, input: { minHeight: 46, maxHeight: 130, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, paddingRight: 50, color: t.text, backgroundColor: t.soft, fontSize: 15 }, sendButton: { position: "absolute", right: 20, bottom: 18, width: 35, height: 35, borderRadius: 18, backgroundColor: t.bronze, alignItems: "center", justifyContent: "center" }, sendDisabled: { opacity: 0.35 }, modalScrim: { flex: 1, backgroundColor: t.overlay, justifyContent: "flex-end" }, drawer: { height: "94%", backgroundColor: t.glassStrong, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 18 }, drawerHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 15 }, drawerTitle: { color: t.ink, fontSize: 24, fontWeight: "900" }, newChat: { flexDirection: "row", alignItems: "center", gap: 9, padding: 13, borderRadius: 12, backgroundColor: t.accent }, newChatText: { color: t.accentText, fontWeight: "800" }, searchInput: { marginTop: 12, borderRadius: 12, backgroundColor: t.soft, color: t.text, padding: 12 }, searchResult: { paddingVertical: 10 }, archiveTabs: { flexDirection: "row", gap: 20, borderBottomWidth: 1, borderBottomColor: t.line, paddingVertical: 16 }, tab: { color: t.muted, fontWeight: "700" }, activeTab: { color: t.caramel, fontWeight: "900" }, threadList: { flex: 1 }, threadItem: { flexDirection: "row", alignItems: "center", gap: 9, padding: 12, borderRadius: 10 }, threadMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 9 }, threadActive: { backgroundColor: t.soft }, threadText: { flex: 1, color: t.text, fontSize: 14 }, signOut: { flexDirection: "row", gap: 8, alignItems: "center", paddingVertical: 14 }, signOutText: { color: t.danger, fontWeight: "800" }, sheet: { backgroundColor: t.glassStrong, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 18, gap: 10 }, sheetTitle: { color: t.ink, fontSize: 22, fontWeight: "900" }, tierOption: { flexDirection: "row", alignItems: "center", padding: 13, borderRadius: 13, borderWidth: 1, borderColor: t.line, gap: 10 }, tierSelected: { borderColor: t.caramel, backgroundColor: t.accentSoft }, tierUnavailable: { opacity: 0.45 }, tierOptionText: { flex: 1 }, tierLabel: { color: t.text, fontWeight: "900", fontSize: 15 }, tierDescription: { color: t.muted, marginTop: 3, fontSize: 12 }, closeSheet: { alignItems: "center", paddingVertical: 14 }, closeText: { color: t.caramel, fontWeight: "900" }, settings: { height: "90%", backgroundColor: t.glassStrong, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 18 }, settingsContent: { gap: 12, paddingBottom: 30 }, sectionTitle: { color: t.caramel, fontWeight: "900", fontSize: 13, marginTop: 10 }, settingsInput: { borderRadius: 12, backgroundColor: t.soft, color: t.text, padding: 12 }, settingsMeta: { color: t.muted, fontSize: 13, lineHeight: 20 }, saveButton: { alignSelf: "flex-start", backgroundColor: t.bronze, padding: 10, borderRadius: 10 }, saveText: { color: t.accentText, fontWeight: "800" }, settingRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 13, borderRadius: 12, backgroundColor: t.soft }, settingLabel: { color: t.text, fontWeight: "700" }, settingValue: { color: t.caramel, fontWeight: "900" }, renameCard: { margin: 22, padding: 18, borderRadius: 20, backgroundColor: t.glassStrong, gap: 14 }, renameActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 18 },
}); }
