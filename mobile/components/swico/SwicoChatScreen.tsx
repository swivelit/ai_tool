import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, Platform,
  Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";

import { useAuth } from "@/components/AuthProvider";
import { Screen } from "@/components/ui";
import { Brand } from "@/constants/theme";
import { MarkdownText } from "./MarkdownText";
import {
  cancelChatRequest, chatRequestStatus, deleteThread, deleteUpload, getBootstrap, getMemorySettings,
  getLedger, getMessages, getPayments, getProfileSettings, getThreads, getUsage, listKnowledge, newSwicoRequestId, patchThread, searchChats,
  sendFeedback, streamChat, synthesizeAudio, transcribeAudioUri,
  updateAssistant, updateMemorySettings, updateProfileSettings, uploadDocument, uploadRepository,
  type SwicoApiError,
} from "@/lib/swicoApi";
import { emptySwicoStreamState, reduceSwicoStream, type SwicoStreamState } from "@/lib/swicoChatReducer";
import type { Attachment, Bootstrap, Message, ProfileSettings, Thread } from "@/lib/swicoTypes";

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
  const insets = useSafeAreaInsets();
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [archived, setArchived] = useState(false);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [editTarget, setEditTarget] = useState<string | null>(null);
  const [stream, setStream] = useState<SwicoStreamState>(emptySwicoStreamState);
  const [streaming, setStreaming] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [tierModal, setTierModal] = useState(false);
  const [settingsModal, setSettingsModal] = useState(false);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<{ thread_id: string | null; message_id: string | null; snippet: string }[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [repositoryId, setRepositoryId] = useState<string | undefined>();
  const [renameTarget, setRenameTarget] = useState<Thread | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const controllerRef = useRef<AbortController | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const listRef = useRef<FlatList<Message>>(null);

  const reloadThreads = useCallback(async (isArchived = archived) => {
    if (!user) return;
    const result = await getThreads(user, isArchived);
    setThreads(result.items);
  }, [archived, user]);

  const reloadMessages = useCallback(async (threadId: string) => {
    if (!user) return;
    const result = await getMessages(user, threadId);
    setMessages(result.items);
    setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    void Promise.all([getBootstrap(user), getThreads(user)]).then(([nextBootstrap, nextThreads]) => {
      if (!alive) return;
      setBootstrap(nextBootstrap);
      setThreads(nextThreads.items);
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

  const send = useCallback(async (override?: string, options: { continueId?: string; editId?: string; regenerateId?: string } = {}) => {
    if (!user || streaming) return;
    const text = String(override ?? (options.continueId ? "Continue response" : draft)).trim();
    if (!text) return;
    const id = newSwicoRequestId();
    const threadId = activeThread || "new-thread";
    const payload = {
      request_id: id, message: text, ...(activeThread ? { thread_id: activeThread } : {}),
      attachment_ids: attachments.map(item => item.id), ...(repositoryId ? { repository_id: repositoryId } : {}),
      input_mode: "text" as const,
      ...(options.continueId ? { continue_message_id: options.continueId } : {}),
      ...((options.editId || editTarget) ? { edit_message_id: options.editId || editTarget! } : {}),
      ...(options.regenerateId ? { regenerate_message_id: options.regenerateId } : {}),
    };
    setDraft(""); setEditTarget(null); setError(""); setStreaming(true); setRequestId(id);
    streamedThreadRef.current = activeThread;
    setStream({ ...emptySwicoStreamState, phase: "connecting", assistant: {
      id: `stream-${id}`, thread_id: threadId, role: "assistant", content: "", request_id: id,
      tier: bootstrap?.assistant.tier || null, tier_label: bootstrap?.assistant.tier_label || "Swico",
      input_tokens: 0, output_tokens: 0, usage_source: null, charge_micros: 0, status: "streaming",
      created_at: nowIso(), input_mode: "text", voice_turn_id: null, reply_language: null,
    }});
    setMessages(value => [...value, makeUserMessage(text, id, threadId)]);
    const controller = new AbortController(); controllerRef.current = controller;
    try {
      await streamChat(user, payload, {
        onAccepted: () => undefined,
        onEvent: applyStreamEvent,
      }, controller.signal);
      if (activeThread || streamedThreadRef.current) {
        const resolved = activeThread || streamedThreadRef.current;
        if (resolved) await reloadMessages(resolved);
      }
      await Promise.all([reloadThreads(false), getBootstrap(user).then(setBootstrap)]);
    } catch (caught) {
      if ((caught as { name?: string }).name !== "AbortError") {
        const apiError = caught as Partial<SwicoApiError>;
        setError(apiError.message || "Swico could not complete that response.");
      }
    } finally {
      controllerRef.current = null; setStreaming(false); setRequestId(null);
    }
  }, [activeThread, applyStreamEvent, attachments, bootstrap?.assistant.tier, bootstrap?.assistant.tier_label, draft, editTarget, reloadMessages, reloadThreads, repositoryId, streaming, user]);

  const stop = useCallback(async () => {
    if (!user || !requestId) return;
    try { await cancelChatRequest(user, requestId); } catch { /* the server remains authoritative */ }
    controllerRef.current?.abort();
  }, [requestId, user]);

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

  const chooseThread = (id: string) => { setEditTarget(null); setActiveThread(id); setDrawer(false); setSearch(""); };
  const newChat = () => { setEditTarget(null); setActiveThread(null); setMessages([]); setAttachments([]); setRepositoryId(undefined); setDrawer(false); };

  const pickDocument = useCallback(async () => {
    if (!user || !bootstrap?.features.web_attachments) return;
    const result = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
    if (result.canceled || !result.assets[0]) return;
    const file = result.assets[0];
    try {
      const attachment = await uploadDocument(user, { uri: file.uri, name: file.name, type: file.mimeType || "application/octet-stream" });
      setAttachments(value => [...value, attachment as Attachment]);
    } catch (caught) { setError((caught as Error).message || "Upload failed."); }
  }, [bootstrap?.features.web_attachments, user]);

  const pickRepository = useCallback(async () => {
    if (!user || !bootstrap?.features.web_repository_upload) return;
    const result = await DocumentPicker.getDocumentAsync({ type: "application/zip", copyToCacheDirectory: true });
    if (result.canceled || !result.assets[0]) return;
    const file = result.assets[0];
    try {
      const repository = await uploadRepository(user, { uri: file.uri, name: file.name, type: "application/zip" }, newSwicoRequestId());
      setRepositoryId(repository.id);
    } catch (caught) { setError((caught as Error).message || "Repository upload failed."); }
  }, [bootstrap?.features.web_repository_upload, user]);

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

  if (!user || !bootstrap) return <Screen><View style={styles.loading}><ActivityIndicator color={Brand.caramel} /><Text style={styles.muted}>Loading Swico...</Text></View></Screen>;
  const activeTitle = threads.find(item => item.id === activeThread)?.title || "New chat";
  return (
    <Screen safeArea={false}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <Pressable onPress={() => setDrawer(true)} style={styles.iconButton} accessibilityLabel="Open chat drawer"><Ionicons name="menu" size={24} color={Brand.ink} /></Pressable>
          <View style={styles.headerCenter}><Text style={styles.brand}>Swico</Text><Text style={styles.threadTitle} numberOfLines={1}>{activeTitle}</Text></View>
          <Pressable onPress={() => setSettingsModal(true)} style={styles.iconButton} accessibilityLabel="Open settings"><Ionicons name="settings-outline" size={21} color={Brand.ink} /></Pressable>
        </View>
        <View style={styles.balance}><Text style={styles.balanceText}>{bootstrap.wallets?.chat?.balance_display === "Unlimited" ? "Unlimited" : `${bootstrap.wallets?.chat?.available_micros ?? bootstrap.wallet.available_micros} credits available`}</Text><Text style={styles.tierText}>{bootstrap.assistant.tier_label}</Text></View>
        {stream.phase === "queued" || stream.phase === "starting" ? <View style={styles.queueBanner}><Ionicons name="time-outline" color={Brand.caramel} size={16} /><Text style={styles.queueText}>{stream.phase === "starting" ? "Starting..." : `Waiting · position ${stream.queuePosition ?? "—"}${stream.estimatedWaitSeconds ? ` · ~${stream.estimatedWaitSeconds}s` : ""}`}</Text></View> : null}
        {error ? <Pressable onPress={() => setError("")} style={styles.errorBanner}><Text style={styles.errorText}>{error}</Text></Pressable> : null}
        {messages.length === 0 ? <View style={styles.empty}><Text style={styles.emptyTitle}>How can Swico help?</Text><Text style={styles.emptyText}>Ask a question, upload a document, or continue a conversation from the web.</Text></View> : <FlatList ref={listRef} data={messages} keyExtractor={item => item.id} contentContainerStyle={styles.messages} renderItem={({ item }) => <MessageRow message={item} onCopy={() => void Clipboard.setStringAsync(item.content)} onShare={() => void Share.share({ message: item.content })} onVoice={() => void playVoice(item)} onFeedback={rating => void sendFeedback(user, item.id, rating)} onContinue={() => void send(undefined, { continueId: item.id })} onRegenerate={() => { const original = messages.find(candidate => candidate.role === "user" && candidate.request_id === item.request_id); if (original) void send(original.content, { regenerateId: item.id }); }} onEdit={() => { setDraft(item.content); setEditTarget(item.id); }} />} />}
        {attachments.length || repositoryId ? <View style={styles.attachmentBar}>{attachments.map(item => <View key={item.id} style={styles.chip}><Text style={styles.chipText} numberOfLines={1}>{item.name}</Text><Pressable onPress={() => { setAttachments(value => value.filter(entry => entry.id !== item.id)); void deleteUpload(user, item.id); }}><Ionicons name="close" size={14} color={Brand.ink} /></Pressable></View>)}{repositoryId ? <View style={styles.chip}><Text style={styles.chipText}>Repository ready</Text><Pressable onPress={() => setRepositoryId(undefined)}><Ionicons name="close" size={14} color={Brand.ink} /></Pressable></View> : null}</View> : null}
        <View style={[styles.composerShell, { paddingBottom: Math.max(insets.bottom, 10) }]}>
          <View style={styles.composerTools}><Pressable onPress={pickDocument} accessibilityLabel="Attach file"><Ionicons name="add-circle-outline" size={25} color={Brand.caramel} /></Pressable><Pressable onPress={pickRepository} accessibilityLabel="Attach repository"><Ionicons name="logo-github" size={21} color={Brand.caramel} /></Pressable><Pressable onPress={() => void startDictation()} accessibilityLabel="Dictate"><Ionicons name="mic-outline" size={23} color={Brand.caramel} /></Pressable><Pressable onPress={() => setTierModal(true)} style={styles.tierPill}><Text style={styles.tierPillText}>{bootstrap.assistant.tier_label}</Text><Ionicons name="chevron-down" size={14} color={Brand.caramel} /></Pressable></View>
          <TextInput testID="chat-input" value={draft} onChangeText={setDraft} placeholder="Message Swico" placeholderTextColor={Brand.muted} multiline maxLength={bootstrap.uploads.long_input_enabled ? (bootstrap.uploads.long_input_max_chars || 64000) : 16000} style={styles.input} editable={!streaming} onSubmitEditing={() => void send()} blurOnSubmit={false} />
          <Pressable testID="chat-send-button" accessibilityLabel={streaming ? "Stop generation" : "Send message"} onPress={() => streaming ? void stop() : void send()} disabled={!streaming && !draft.trim()} style={[styles.sendButton, !streaming && !draft.trim() && styles.sendDisabled]}><Ionicons name={streaming ? "stop" : "arrow-up"} size={20} color={Brand.ink} /></Pressable>
        </View>
      </KeyboardAvoidingView>
      <Drawer visible={drawer} onClose={() => setDrawer(false)} threads={threads} archived={archived} setArchived={value => { setArchived(value); void reloadThreads(value); }} active={activeThread} onSelect={chooseThread} onNew={newChat} onActions={threadAction} search={search} setSearch={setSearch} results={searchResults} onSignOut={() => void signOutUser()} />
      <TierModal visible={tierModal} onClose={() => setTierModal(false)} bootstrap={bootstrap} onChoose={async tier => { try { const assistant = await updateAssistant(user, tier); setBootstrap(value => value ? { ...value, assistant } : value); setTierModal(false); } catch (caught) { setError((caught as Error).message); } }} />
      <SettingsModal visible={settingsModal} onClose={() => setSettingsModal(false)} user={user} bootstrap={bootstrap} onBootstrap={setBootstrap} />
      <Modal visible={Boolean(renameTarget)} transparent animationType="fade" onRequestClose={() => setRenameTarget(null)}><View style={styles.modalScrim}><View style={styles.renameCard}><Text style={styles.sheetTitle}>Rename chat</Text><TextInput autoFocus value={renameTitle} onChangeText={setRenameTitle} style={styles.settingsInput} placeholder="Chat name" placeholderTextColor={Brand.muted} /><View style={styles.renameActions}><Pressable onPress={() => setRenameTarget(null)}><Text style={styles.tab}>Cancel</Text></Pressable><Pressable onPress={() => void saveRename()} style={styles.saveButton}><Text style={styles.saveText}>Save</Text></Pressable></View></View></View></Modal>
    </Screen>
  );
}

function MessageRow({ message, onCopy, onShare, onVoice, onFeedback, onContinue, onRegenerate, onEdit }: { message: Message; onCopy: () => void; onShare: () => void; onVoice: () => void; onFeedback: (rating: "up" | "down") => void; onContinue: () => void; onRegenerate: () => void; onEdit: () => void }) {
  const assistant = message.role === "assistant";
  return <View style={[styles.messageRow, assistant ? styles.assistantRow : styles.userRow]}><View style={[styles.messageCard, assistant ? styles.assistantCard : styles.userCard]}>{assistant ? <MarkdownText value={message.content || "…"} /> : <Text style={styles.userText}>{message.content}</Text>}{assistant && message.sources?.length ? <Text style={styles.sourceText}>Sources: {message.sources.map(source => source.label).join(" · ")}</Text> : null}{message.truncated && message.can_continue ? <Pressable onPress={onContinue} style={styles.continueButton}><Text style={styles.continueText}>Continue generating</Text></Pressable> : null}<View style={styles.messageActions}><Pressable onPress={onCopy}><Ionicons name="copy-outline" size={16} color={Brand.muted} /></Pressable>{assistant ? <><Pressable onPress={onShare}><Ionicons name="share-outline" size={16} color={Brand.muted} /></Pressable><Pressable onPress={onVoice}><Ionicons name="volume-medium-outline" size={16} color={Brand.muted} /></Pressable><Pressable onPress={onRegenerate}><Ionicons name="refresh-outline" size={16} color={Brand.muted} /></Pressable><Pressable onPress={() => onFeedback("up")}><Ionicons name="thumbs-up-outline" size={16} color={Brand.muted} /></Pressable><Pressable onPress={() => onFeedback("down")}><Ionicons name="thumbs-down-outline" size={16} color={Brand.muted} /></Pressable></> : <Pressable onPress={onEdit}><Ionicons name="create-outline" size={16} color={Brand.muted} /></Pressable>}</View></View></View>;
}

function Drawer({ visible, onClose, threads, active, onSelect, onNew, onActions, archived, setArchived, search, setSearch, results, onSignOut }: { visible: boolean; onClose: () => void; threads: Thread[]; active: string | null; onSelect: (id: string) => void; onNew: () => void; onActions: (thread: Thread) => void; archived: boolean; setArchived: (value: boolean) => void; search: string; setSearch: (value: string) => void; results: { thread_id: string | null; message_id: string | null; snippet: string }[]; onSignOut: () => void }) {
  return <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}><View style={styles.modalScrim}><View style={styles.drawer}><View style={styles.drawerHeader}><Text style={styles.drawerTitle}>Swico</Text><Pressable onPress={onClose}><Ionicons name="close" size={24} color={Brand.ink} /></Pressable></View><Pressable onPress={onNew} style={styles.newChat}><Ionicons name="add" size={20} color={Brand.ink} /><Text style={styles.newChatText}>New chat</Text></Pressable><TextInput value={search} onChangeText={setSearch} placeholder="Search chats" placeholderTextColor={Brand.muted} style={styles.searchInput} />{results.length ? <View>{results.map(item => <Pressable key={`${item.thread_id}-${item.message_id}`} onPress={() => item.thread_id && onSelect(item.thread_id)} style={styles.searchResult}><Text style={styles.threadText}>{item.snippet}</Text></Pressable>)}</View> : null}<View style={styles.archiveTabs}><Pressable onPress={() => setArchived(false)}><Text style={!archived ? styles.activeTab : styles.tab}>Chats</Text></Pressable><Pressable onPress={() => setArchived(true)}><Text style={archived ? styles.activeTab : styles.tab}>Archived</Text></Pressable></View><ScrollView style={styles.threadList}>{threads.map(thread => <View key={thread.id} style={[styles.threadItem, thread.id === active && styles.threadActive]}><Pressable onPress={() => onSelect(thread.id)} style={styles.threadMain}><Ionicons name="chatbubble-outline" size={17} color={Brand.muted} /><Text style={styles.threadText} numberOfLines={1}>{thread.title || "New chat"}</Text></Pressable><Pressable onPress={() => onActions(thread)} accessibilityLabel={`Actions for ${thread.title || "chat"}`}><Ionicons name="ellipsis-horizontal" size={18} color={Brand.muted} /></Pressable></View>)}</ScrollView><Pressable onPress={onSignOut} style={styles.signOut}><Ionicons name="log-out-outline" size={18} color={Brand.danger} /><Text style={styles.signOutText}>Sign out</Text></Pressable></View></View></Modal>;
}

function TierModal({ visible, onClose, bootstrap, onChoose }: { visible: boolean; onClose: () => void; bootstrap: Bootstrap; onChoose: (tier: string) => Promise<void> }) {
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}><View style={styles.modalScrim}><View style={styles.sheet}><Text style={styles.sheetTitle}>Swico mode</Text>{bootstrap.assistant.tiers.map(option => <Pressable key={option.id} disabled={!option.available || option.selected} onPress={() => void onChoose(option.id)} style={[styles.tierOption, option.selected && styles.tierSelected, !option.available && styles.tierUnavailable]}><View style={styles.tierOptionText}><Text style={styles.tierLabel}>{option.label}</Text><Text style={styles.tierDescription}>{option.description}</Text></View>{option.selected ? <Ionicons name="checkmark-circle" size={22} color={Brand.caramel} /> : null}</Pressable>)}<Pressable onPress={onClose} style={styles.closeSheet}><Text style={styles.closeText}>Close</Text></Pressable></View></View></Modal>;
}

function SettingsModal({ visible, onClose, user, bootstrap, onBootstrap }: { visible: boolean; onClose: () => void; user: NonNullable<ReturnType<typeof useAuth>["user"]>; bootstrap: Bootstrap; onBootstrap: React.Dispatch<React.SetStateAction<Bootstrap | null>> }) {
  const [profile, setProfile] = useState<ProfileSettings | null>(null);
  const [memoryEnabled, setMemoryEnabled] = useState(false);
  const [usage, setUsage] = useState<{ request_count?: number; debited_ai_credits?: string } | null>(null);
  const [accountCounts, setAccountCounts] = useState({ knowledge: 0, ledger: 0, payments: 0 });
  useEffect(() => {
    if (!visible) return;
    void Promise.all([getProfileSettings(user), getMemorySettings(user), getUsage(user)]).then(([nextProfile, memory, nextUsage]) => {
      setProfile(nextProfile); setMemoryEnabled(memory.enabled); setUsage(nextUsage);
    }).catch(() => undefined);
    const knowledgeRequest = bootstrap.features.web_knowledge_library ? listKnowledge(user) : Promise.resolve({ items: [] });
    void Promise.all([knowledgeRequest, getLedger(user), getPayments(user)]).then(([knowledge, ledger, payments]) => {
      setAccountCounts({ knowledge: knowledge.items.length, ledger: ledger.items.length, payments: payments.items.length });
    }).catch(() => undefined);
  }, [bootstrap.features.web_knowledge_library, user, visible]);
  return <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}><View style={styles.modalScrim}><View style={styles.settings}><View style={styles.drawerHeader}><Text style={styles.sheetTitle}>Settings</Text><Pressable onPress={onClose}><Ionicons name="close" size={24} color={Brand.ink} /></Pressable></View><ScrollView contentContainerStyle={styles.settingsContent}>{profile ? <><Text style={styles.sectionTitle}>Profile</Text><TextInput value={profile.name} onChangeText={value => setProfile({ ...profile, name: value })} style={styles.settingsInput} placeholder="Name" placeholderTextColor={Brand.muted} /><Text style={styles.settingsMeta}>{profile.email || bootstrap.user.email || ""}</Text><Pressable onPress={async () => { if (!profile) return; const saved = await updateProfileSettings(user, { name: profile.name }); setProfile(saved); }} style={styles.saveButton}><Text style={styles.saveText}>Save profile</Text></Pressable></> : null}<Text style={styles.sectionTitle}>Usage & wallet</Text><Text style={styles.settingsMeta}>{usage?.request_count ?? 0} requests · {usage?.debited_ai_credits ?? "0"} AI credits used</Text><Text style={styles.settingsMeta}>{bootstrap.wallets?.chat.available_micros ?? bootstrap.wallet.available_micros} chat-credit balance</Text><Text style={styles.sectionTitle}>Memory</Text><Pressable onPress={async () => { const next = await updateMemorySettings(user, !memoryEnabled); setMemoryEnabled(next.enabled); }} style={styles.settingRow}><Text style={styles.settingLabel}>Cross-chat memory</Text><Text style={styles.settingValue}>{memoryEnabled ? "On" : "Off"}</Text></Pressable><Text style={styles.sectionTitle}>Knowledge & data</Text><Text style={styles.settingsMeta}>{accountCounts.knowledge} knowledge documents · {accountCounts.ledger} ledger entries · {accountCounts.payments} payments</Text><Text style={styles.settingsMeta}>These records, archived chats, and memory use the same server account as the website.</Text><Pressable onPress={async () => { const wallet = await getBootstrap(user); onBootstrap(wallet); }} style={styles.settingRow}><Text style={styles.settingLabel}>Refresh account data</Text><Ionicons name="refresh" size={18} color={Brand.caramel} /></Pressable><Pressable onPress={onClose} style={styles.closeSheet}><Text style={styles.closeText}>Done</Text></Pressable></ScrollView></View></View></Modal>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 }, loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }, muted: { color: Brand.muted }, header: { minHeight: 62, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderBottomColor: Brand.line }, iconButton: { width: 42, height: 42, alignItems: "center", justifyContent: "center" }, headerCenter: { flex: 1, alignItems: "center" }, brand: { color: Brand.ink, fontSize: 20, fontWeight: "900" }, threadTitle: { color: Brand.muted, fontSize: 11, maxWidth: 190 }, balance: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 18, paddingVertical: 7 }, balanceText: { color: Brand.muted, fontSize: 11 }, tierText: { color: Brand.caramel, fontSize: 11, fontWeight: "800" }, queueBanner: { marginHorizontal: 14, borderRadius: 12, backgroundColor: "rgba(87, 222, 255, 0.13)", padding: 9, flexDirection: "row", alignItems: "center", gap: 7 }, queueText: { color: Brand.caramel, fontSize: 12, fontWeight: "700" }, errorBanner: { margin: 12, padding: 10, borderRadius: 10, backgroundColor: "rgba(255, 138, 138, 0.16)" }, errorText: { color: Brand.danger, fontSize: 12 }, empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 38 }, emptyTitle: { color: Brand.ink, fontSize: 28, fontWeight: "900", textAlign: "center" }, emptyText: { color: Brand.muted, textAlign: "center", lineHeight: 21, marginTop: 10 }, messages: { padding: 14, gap: 12, paddingBottom: 22 }, messageRow: { width: "100%" }, assistantRow: { alignItems: "flex-start" }, userRow: { alignItems: "flex-end" }, messageCard: { maxWidth: "90%", borderRadius: 18, padding: 13 }, assistantCard: { backgroundColor: Brand.raised, borderWidth: 1, borderColor: Brand.line }, userCard: { backgroundColor: "#2f73ff" }, userText: { color: "#fff", fontSize: 15, lineHeight: 23 }, sourceText: { color: Brand.caramel, fontSize: 11, marginTop: 10 }, messageActions: { flexDirection: "row", gap: 15, marginTop: 12 }, continueButton: { marginTop: 12, padding: 9, borderRadius: 9, backgroundColor: "rgba(87, 222, 255, 0.13)" }, continueText: { color: Brand.caramel, fontWeight: "800", fontSize: 12 }, attachmentBar: { flexDirection: "row", gap: 7, paddingHorizontal: 14, paddingVertical: 5, flexWrap: "wrap" }, chip: { flexDirection: "row", alignItems: "center", gap: 5, maxWidth: 180, backgroundColor: Brand.soft, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 6 }, chipText: { color: Brand.text, fontSize: 11 }, composerShell: { borderTopWidth: 1, borderTopColor: Brand.line, paddingHorizontal: 13, paddingTop: 8, backgroundColor: Brand.glassStrong }, composerTools: { flexDirection: "row", alignItems: "center", gap: 16, marginBottom: 7 }, tierPill: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 3, borderWidth: 1, borderColor: Brand.lineStrong, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 5 }, tierPillText: { color: Brand.caramel, fontSize: 11, fontWeight: "800" }, input: { minHeight: 46, maxHeight: 130, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, paddingRight: 50, color: Brand.text, backgroundColor: Brand.soft, fontSize: 15 }, sendButton: { position: "absolute", right: 20, bottom: 18, width: 35, height: 35, borderRadius: 18, backgroundColor: Brand.bronze, alignItems: "center", justifyContent: "center" }, sendDisabled: { opacity: 0.35 }, modalScrim: { flex: 1, backgroundColor: Brand.overlay, justifyContent: "flex-end" }, drawer: { height: "94%", backgroundColor: Brand.glassStrong, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 18 }, drawerHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 15 }, drawerTitle: { color: Brand.ink, fontSize: 24, fontWeight: "900" }, newChat: { flexDirection: "row", alignItems: "center", gap: 9, padding: 13, borderRadius: 12, backgroundColor: "#2f73ff" }, newChatText: { color: "#fff", fontWeight: "800" }, searchInput: { marginTop: 12, borderRadius: 12, backgroundColor: Brand.soft, color: Brand.text, padding: 12 }, searchResult: { paddingVertical: 10 }, archiveTabs: { flexDirection: "row", gap: 20, borderBottomWidth: 1, borderBottomColor: Brand.line, paddingVertical: 16 }, tab: { color: Brand.muted, fontWeight: "700" }, activeTab: { color: Brand.caramel, fontWeight: "900" }, threadList: { flex: 1 }, threadItem: { flexDirection: "row", alignItems: "center", gap: 9, padding: 12, borderRadius: 10 }, threadMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 9 }, threadActive: { backgroundColor: Brand.soft }, threadText: { flex: 1, color: Brand.text, fontSize: 14 }, signOut: { flexDirection: "row", gap: 8, alignItems: "center", paddingVertical: 14 }, signOutText: { color: Brand.danger, fontWeight: "800" }, sheet: { backgroundColor: Brand.glassStrong, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 18, gap: 10 }, sheetTitle: { color: Brand.ink, fontSize: 22, fontWeight: "900" }, tierOption: { flexDirection: "row", alignItems: "center", padding: 13, borderRadius: 13, borderWidth: 1, borderColor: Brand.line, gap: 10 }, tierSelected: { borderColor: Brand.caramel, backgroundColor: "rgba(87, 222, 255, 0.13)" }, tierUnavailable: { opacity: 0.45 }, tierOptionText: { flex: 1 }, tierLabel: { color: Brand.text, fontWeight: "900", fontSize: 15 }, tierDescription: { color: Brand.muted, marginTop: 3, fontSize: 12 }, closeSheet: { alignItems: "center", paddingVertical: 14 }, closeText: { color: Brand.caramel, fontWeight: "900" }, settings: { height: "90%", backgroundColor: Brand.glassStrong, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 18 }, settingsContent: { gap: 12, paddingBottom: 30 }, sectionTitle: { color: Brand.caramel, fontWeight: "900", fontSize: 13, marginTop: 10 }, settingsInput: { borderRadius: 12, backgroundColor: Brand.soft, color: Brand.text, padding: 12 }, settingsMeta: { color: Brand.muted, fontSize: 13, lineHeight: 20 }, saveButton: { alignSelf: "flex-start", backgroundColor: Brand.bronze, padding: 10, borderRadius: 10 }, saveText: { color: "#fff", fontWeight: "800" }, settingRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 13, borderRadius: 12, backgroundColor: Brand.soft }, settingLabel: { color: Brand.text, fontWeight: "700" }, settingValue: { color: Brand.caramel, fontWeight: "900" }, renameCard: { margin: 22, padding: 18, borderRadius: 20, backgroundColor: Brand.glassStrong, gap: 14 }, renameActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 18 },
});
