import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, Animated, FlatList, KeyboardAvoidingView, Modal, Platform,
  Image, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
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
  cancelChatRequest, chatRequestStatus, createVoiceSession, deleteRepository, deleteThread, deleteUpload, endVoiceSession, getBootstrap,
  getMessages, getThreads, newSwicoRequestId, patchThread, searchChats,
  approveKnowledge, sendFeedback, streamChat, synthesizeAudio, transcribeAudioUri, uploadText,
  updateAssistant, uploadDocument, uploadRepository,
  type SwicoApiError,
} from "@/lib/swicoApi";
import { emptySwicoStreamState, reduceSwicoStream, type SwicoStreamState } from "@/lib/swicoChatReducer";
import type { Attachment, Bootstrap, ChatRequestPayload, InputMode, Message, RepositorySnapshot, SearchResult, Thread } from "@/lib/swicoTypes";
import { SwicoRealtimeVoiceTransport, realtimePcmAvailable, realtimePcmPlaybackAvailable, startRealtimePcmPlayback, stopRealtimePcmPlayback, validateRealtimeAudioStart, writeRealtimePcmPlayback } from "@/lib/swicoRealtimeVoice";
import { useConnectivity } from "@/hooks/use-connectivity";
import { repositoryDetachCode, repositoryExpired, repositoryUsable } from "@/lib/swicoRepository";
import { SwicoBilling } from "./SwicoBilling";
import { SwicoLegalScreen } from "./SwicoLegalScreen";
import { SwicoSettings } from "./SwicoSettings";
import { applyAuthoritativeVoiceWallet, tokenRangeLabel } from "@/lib/swicoBilling";
import { assistantActionsEnabled, hasSendableContent, latestEditableUserId, retryAvailability } from "@/lib/swicoMessageEligibility";
import { fallbackMessageOffset, messageIndexForSearch } from "@/lib/swicoNavigation";
import { VoiceReplyCache, type VoiceReplyState } from "@/lib/swicoVoiceReply";
import { canChatWithRepository, canDictate, canReplyWithVoice, canUploadRepository, canUseAttachments, responseProvenanceVisible, voiceAvailability } from "@/lib/swicoCapabilities";
import { captureSwicoHistoryScope, captureSwicoScope, isSwicoHistoryScopeCurrent, isSwicoScopeCurrent, type SwicoRequestScope } from "@/lib/swicoRequestScope";
import { SwicoBusyOperationController, type SwicoBusyOperation } from "@/lib/swicoBusyOperation";
import { buildRegeneratePayload, normalizeSwicoMutationOptions } from "@/lib/swicoRequestPayload";
import { appendWithinSwicoAttachmentCapacity, detachSwicoAttachment, expiredExplicitAttachments, mergeSwicoHistoryAttachments } from "@/lib/swicoAttachmentState";

function nowIso() { return new Date().toISOString(); }
function makeUserMessage(text: string, requestId: string, threadId: string, attachments: Attachment[] = []) : Message {
  return {
    id: `pending-${requestId}`, thread_id: threadId, role: "user", content: text,
    request_id: requestId, tier: null, tier_label: "", input_tokens: 0, output_tokens: 0,
    usage_source: null, charge_micros: 0, status: "pending", created_at: nowIso(), attachments,
    input_mode: "text", voice_turn_id: null, reply_language: null,
  };
}

export default function SwicoChatScreen() {
  const { user, signOutUser } = useAuth();
  const { palette: t, themePreference, setThemePreference } = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const insets = useSafeAreaInsets();
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [hasMoreThreads, setHasMoreThreads] = useState(false);
  const [archived, setArchived] = useState(false);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [draftVoiceTurnId, setDraftVoiceTurnId] = useState<string | null>(null);
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
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [repositoryId, setRepositoryId] = useState<string | undefined>();
  const [repositoryMeta, setRepositoryMeta] = useState<RepositorySnapshot | null>(null);
  const [repositoryThreadId, setRepositoryThreadId] = useState<string | null>(null);
  const [repositoryOwnerUid, setRepositoryOwnerUid] = useState<string | null>(null);
  const [longInputMode, setLongInputMode] = useState<"summarize" | "analyze" | "ask_questions" | "rewrite" | "translate">("analyze");
  const [uploading, setUploading] = useState(false);
  const [billing, setBilling] = useState(false);
  const [billingBucket, setBillingBucket] = useState<"chat" | "voice">("chat");
  const [legalPage, setLegalPage] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [bootstrapFailed, setBootstrapFailed] = useState(false);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [voiceReplyStates, setVoiceReplyStates] = useState<Record<string, VoiceReplyState>>({});
  const [renameTarget, setRenameTarget] = useState<Thread | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [editorMessage, setEditorMessage] = useState<Message | null>(null);
  const [editedResponses, setEditedResponses] = useState<Record<string, string>>({});
  const [pendingScrollMessageId, setPendingScrollMessageId] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const activeRequestRef = useRef<string | null>(null);
  const transportAttemptRef = useRef<string | null>(null);
  const navigationGenerationRef = useRef(0);
  const threadListGenerationRef = useRef(0);
  const messageHistoryGenerationRef = useRef(0);
  const activeThreadRef = useRef<string | null>(activeThread);
  const archivedRef = useRef(archived);
  const pendingAttachmentIdsRef = useRef(new Set<string>());
  const detachedAttachmentIdsRef = useRef(new Map<string, Set<string>>());
  const localConversationIdRef = useRef(`new-${newSwicoRequestId()}`);
  const submittedPayloadsRef = useRef(new Map<string, ChatRequestPayload>());
  const draftRef = useRef(draft);
  const attachmentsRef = useRef(attachments);
  const searchGenerationRef = useRef(0);
  const cancellationReadyRef = useRef(false);
  const queuedStopRef = useRef(false);
  const cancellationSentRef = useRef(false);
  const stopConfirmedRef = useRef(false);
  const voiceCacheRef = useRef(new VoiceReplyCache<Audio.Sound>(8));
  const busyOperationRef = useRef(new SwicoBusyOperationController());
  const activeVoiceMessageRef = useRef<string | null>(null);
  const dictationRecordingRef = useRef<Audio.Recording | null>(null);
  const listRef = useRef<FlatList<Message>>(null);
  const pinnedToBottomRef = useRef(true);
  const offline = useConnectivity();
  const mobileRelease = String((Constants.expoConfig?.extra as Record<string, unknown> | undefined)?.MOBILE_BUILD_ID || "unavailable");
  const realtimeAvailability = useMemo(() => bootstrap ? voiceAvailability(bootstrap, mobileRelease) : { enabled: false, reason: "Voice Mode is unavailable while Swico is loading.", releaseMismatch: false }, [bootstrap, mobileRelease]);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => { activeThreadRef.current = activeThread; }, [activeThread]);
  useEffect(() => { archivedRef.current = archived; }, [archived]);

  const reloadThreads = useCallback(async (isArchived = archived) => {
    if (!user) return;
    const generation = ++threadListGenerationRef.current;
    const scope = captureSwicoHistoryScope("threads", generation, null, isArchived);
    const result = await getThreads(user, isArchived);
    if (!isSwicoHistoryScopeCurrent(scope, { generation: threadListGenerationRef.current, activeThreadId: activeThreadRef.current, archived: archivedRef.current })) return;
    setThreads(result.items);
    setHasMoreThreads(result.has_more);
  }, [archived, user]);

  const loadMoreThreads = useCallback(async () => {
    if (!user || !hasMoreThreads) return;
    const generation = ++threadListGenerationRef.current;
    const requestedArchived = archived;
    const scope = captureSwicoHistoryScope("threads", generation, null, requestedArchived);
    const result = await getThreads(user, requestedArchived, "", threads.length);
    if (!isSwicoHistoryScopeCurrent(scope, { generation: threadListGenerationRef.current, activeThreadId: activeThreadRef.current, archived: archivedRef.current })) return;
    setThreads(value => [...value, ...result.items.filter(item => !value.some(existing => existing.id === item.id))]);
    setHasMoreThreads(result.has_more);
  }, [archived, hasMoreThreads, threads.length, user]);

  const reloadMessages = useCallback(async (threadId: string) => {
    if (!user) return;
    const generation = ++messageHistoryGenerationRef.current;
    const scope = captureSwicoHistoryScope("messages", generation, threadId, archivedRef.current);
    const result = await getMessages(user, threadId);
    if (!isSwicoHistoryScopeCurrent(scope, { generation: messageHistoryGenerationRef.current, activeThreadId: activeThreadRef.current, archived: archivedRef.current })) return;
    setMessages(result.items);
    const detachedIds = detachedAttachmentIdsRef.current.get(threadId) || new Set<string>();
    const restored = new Map<string, Attachment>();
    result.items.forEach(message => (message.attachments || []).forEach(attachment => {
      if (!detachedIds.has(attachment.id) && attachment.status === "ready" && new Date(attachment.expires_at).getTime() > Date.now()) restored.set(attachment.id, attachment);
    }));
    // A pending selection is user intent, not disposable history. Keep it in
    // the merge even when expired so the composer can offer re-upload/remove.
    const current = attachmentsRef.current.filter(item => pendingAttachmentIdsRef.current.has(item.id));
    if (!isSwicoHistoryScopeCurrent(scope, { generation: messageHistoryGenerationRef.current, activeThreadId: activeThreadRef.current, archived: archivedRef.current })) return;
    const merged = mergeSwicoHistoryAttachments(
      [...restored.values()], current, pendingAttachmentIdsRef.current, 5, detachedIds,
      bootstrap?.uploads,
    );
    attachmentsRef.current = merged;
    setAttachments(merged);
    if (!pendingScrollMessageId) setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
  }, [bootstrap?.uploads, pendingScrollMessageId, user]);

  const loadWorkspace = useCallback(async () => {
    if (!user) return;
    setBootstrapFailed(false);
    try {
      const [nextBootstrap, nextThreads] = await Promise.all([getBootstrap(user), getThreads(user)]);
      setBootstrap(nextBootstrap);
      setThreads(nextThreads.items);
      setHasMoreThreads(nextThreads.has_more);
    } catch {
      setBootstrapFailed(true);
      setError("Swico could not load your workspace. Check your connection and try again.");
    }
  }, [user]);
  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);

  useEffect(() => {
    if (!activeThread || streaming) return;
    const requestedThread = activeThread;
    const requestedGeneration = messageHistoryGenerationRef.current + 1;
    const navigationGeneration = navigationGenerationRef.current;
    void reloadMessages(requestedThread).catch(() => {
      if (
        navigationGenerationRef.current === navigationGeneration
        && activeThreadRef.current === requestedThread
        && messageHistoryGenerationRef.current === requestedGeneration
      ) setError("This conversation could not be loaded.");
    });
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
    if (!repositoryMeta?.expires_at) return;
    const timer = setInterval(() => {
      if (repositoryExpired({ expires_at: repositoryMeta.expires_at, status: repositoryMeta.status })) {
        const expiredId = repositoryId;
        setRepositoryId(undefined);
        setRepositoryMeta(null);
        setRepositoryThreadId(null);
        setError("The active code repository expired and was detached. Upload it again to continue using repository context.");
        if (expiredId && user) void deleteRepository(user, expiredId).catch(() => undefined);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [repositoryId, repositoryMeta, user]);

  useEffect(() => {
    if (!offline) return;
    setError("You are offline. Reconnect to continue using Swico; your current draft is safe.");
  }, [offline]);

  useEffect(() => {
    if (!messages.some(item => item.status === "retryable")) return;
    const timer = setInterval(() => setRetryTick(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [messages]);

  useEffect(() => {
    if (!user || offline || !search.trim() || !bootstrap?.features.web_content_search) {
      setSearchResults([]); return;
    }
    const generation = ++searchGenerationRef.current;
    const query = search.trim();
    const timer = setTimeout(() => void searchChats(user, query).then(result => {
      if (generation === searchGenerationRef.current && query === search.trim()) setSearchResults(result.items);
    }).catch(() => {
      if (generation === searchGenerationRef.current && query === search.trim()) setSearchResults([]);
    }), 300);
    return () => clearTimeout(timer);
  }, [bootstrap?.features.web_content_search, offline, search, user]);

  const updateSearch = useCallback((value: string) => {
    if (!value.trim()) {
      searchGenerationRef.current += 1;
      setSearchResults([]);
    }
    setSearch(value);
  }, []);
  const clearSearch = useCallback(() => {
    searchGenerationRef.current += 1;
    setSearch("");
    setSearchResults([]);
  }, []);

  const streamedThreadRef = useRef<string | null>(null);
  const detachAttachment = useCallback((attachmentId: string) => {
    if (!user) return;
    const scope = activeThreadRef.current || localConversationIdRef.current;
    const ids = detachedAttachmentIdsRef.current.get(scope) || new Set<string>();
    detachedAttachmentIdsRef.current.set(scope, ids);
    setAttachments(value => detachSwicoAttachment(value, attachmentId, pendingAttachmentIdsRef.current, ids));
    void deleteUpload(user, attachmentId).catch(() => undefined);
  }, [user]);
  const applyStreamEvent = useCallback((event: { event: string; data: unknown }) => {
    if (event.event === "error" && event.data && typeof event.data === "object") {
      const data = event.data as Record<string, unknown>;
      setError(String(data.message || "Swico could not complete that response."));
    }
    setStream(previous => {
      const next = reduceSwicoStream(previous, event);
      if (next.assistant) {
        setMessages(value => [...value.filter(item => !(
          item.role === "assistant" && item.request_id === next.assistant?.request_id
        )), next.assistant!]);
      }
      if (next.assistant?.thread_id && next.assistant.thread_id !== "new-thread") {
        const previousThread = activeThreadRef.current;
        if (!previousThread) {
          const detached = detachedAttachmentIdsRef.current.get(localConversationIdRef.current);
          if (detached?.size) {
            detachedAttachmentIdsRef.current.set(next.assistant.thread_id, new Set(detached));
            detachedAttachmentIdsRef.current.delete(localConversationIdRef.current);
          }
        }
        streamedThreadRef.current = next.assistant.thread_id;
        setActiveThread(next.assistant.thread_id);
        if (repositoryId && repositoryThreadId === null) setRepositoryThreadId(next.assistant.thread_id);
      }
      if (pinnedToBottomRef.current) setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 20);
      return next;
    });
  }, [localConversationIdRef, repositoryId, repositoryThreadId]);

  const requestServerCancellation = useCallback(async (targetRequestId: string, targetController: AbortController) => {
    if (!user || cancellationSentRef.current) return;
    const navigationGeneration = navigationGenerationRef.current;
    const transportAttemptId = transportAttemptRef.current;
    const isCurrent = () => (
      navigationGenerationRef.current === navigationGeneration
      && transportAttemptRef.current === transportAttemptId
      && activeRequestRef.current === targetRequestId
    );
    cancellationSentRef.current = true;
    try {
      const result = await cancelChatRequest(user, targetRequestId);
      if (!isCurrent()) return;
      if (result.status === "stopped") {
        stopConfirmedRef.current = true;
        const refreshed = await getBootstrap(user).catch(() => null);
        if (!isCurrent()) return;
        if (refreshed) setBootstrap(refreshed);
        targetController.abort();
      } else if (result.status === "cancelling") {
        setError("Cancellation was requested. Swico is finishing the usage record safely.");
      } else {
        setError("Swico had already completed this response.");
      }
    } catch {
      if (!isCurrent()) return;
      cancellationSentRef.current = false;
      setError("Cancellation could not be confirmed. The stream will remain open until settlement finishes.");
    }
  }, [user]);

  const send = useCallback(async (override?: string, options: { continueId?: string; editId?: string; regenerateId?: string; inputMode?: InputMode; voiceTurnId?: string | null; requestId?: string; attachments?: Attachment[]; payloadOverride?: ChatRequestPayload } = {}) => {
    if (!user || streaming || offline) return;
    if (options.editId && bootstrap?.features.web_message_edit !== true) return;
    if (options.editId && options.editId !== latestEditableUserId(messages, streaming)) return;
    const navigationGeneration = navigationGenerationRef.current;
    const transportAttemptId = newSwicoRequestId();
    const id = options.requestId || newSwicoRequestId();
    const threadId = options.payloadOverride?.thread_id || activeThread || "new-thread";
    const requestScope: SwicoRequestScope = captureSwicoScope(
      navigationGeneration, transportAttemptId, id,
      threadId === "new-thread" ? null : threadId,
    );
    const isCurrentTransport = () => (
      isSwicoScopeCurrent(requestScope, {
        navigationGeneration: navigationGenerationRef.current,
        transportAttemptId: transportAttemptRef.current,
        requestId: activeRequestRef.current,
        threadId: requestScope.threadId,
      })
    );
    const rawText = String(override ?? (options.continueId ? "Continue response" : draft));
    const text = rawText.trim();
    const mutation = normalizeSwicoMutationOptions(options, editTarget);
    const revisionId = mutation.editId;
    const revisionTarget = revisionId
      ? messages.find(item => item.id === revisionId && item.role === "user")
      : options.regenerateId
        ? messages.find(item => item.id === options.regenerateId && item.role === "assistant")
        : null;
    const originalForRevision = revisionTarget?.role === "assistant"
      ? messages.find(item => item.role === "user" && item.request_id === revisionTarget.request_id)
      : revisionTarget;
    let sourceAttachments = options.attachments ?? attachments;
    let selectedAttachments = sourceAttachments;
    if ((options.editId || options.regenerateId) && !selectedAttachments.length) selectedAttachments = originalForRevision?.attachments ?? [];
    const explicitlySelected = Boolean(options.attachments || options.payloadOverride);
    const explicitlyExpired = expiredExplicitAttachments(
      selectedAttachments, pendingAttachmentIdsRef.current, Date.now(), explicitlySelected,
    );
    selectedAttachments = selectedAttachments.filter(item => item.status === "ready" && new Date(item.expires_at).getTime() > Date.now());
    if (explicitlyExpired.length) {
      setError("That attachment has expired. Detach it or upload it again before asking about it.");
      setAttachments(value => value.map(item => explicitlyExpired.some(expiredItem => expiredItem.id === item.id) ? { ...item, status: "expired" as const } : item));
      return;
    }
    const repositoryReady = Boolean(repositoryId && repositoryMeta && repositoryUsable({ ...repositoryMeta, owner_uid: repositoryOwnerUid || "", thread_id: repositoryThreadId }, user.uid, activeThread));
    const retryRepository = Boolean(options.payloadOverride?.repository_id);
    if (!hasSendableContent(text, selectedAttachments, repositoryReady || retryRepository, canChatWithRepository(bootstrap!.features))) return;
    let providerText = text;
    const inlineThreshold = bootstrap?.uploads.long_input_inline_threshold_chars || 16000;
    const needsPreparation = !mutation.continueId && rawText.length > inlineThreshold;
    if (needsPreparation && (!bootstrap?.uploads.long_input_enabled || rawText.length > (bootstrap.uploads.long_input_max_chars || 64000))) {
      setError("This pasted text is larger than the server-supported limit.");
      return;
    }
    if (needsPreparation && selectedAttachments.length >= bootstrap!.uploads.max_files_per_message) {
      setError("Remove one attachment before sending this large pasted text.");
      return;
    }
    const configuredBootstrap = bootstrap!;
    let preparationOperation: SwicoBusyOperation | null = null;
    if (needsPreparation) {
      preparationOperation = beginBusyOperation(navigationGeneration);
      if (!preparationOperation) return;
    }
    transportAttemptRef.current = transportAttemptId;
    activeRequestRef.current = id;
    if (needsPreparation) {
      setError("Preparing large pasted text…");
      try {
        const virtual = await uploadText(user, rawText, longInputMode) as Attachment;
        if (!isCurrentTransport()) {
          await deleteUpload(user, virtual.id).catch(() => undefined);
          finishBusyOperation(preparationOperation!);
          return;
        }
        selectedAttachments = [...selectedAttachments, virtual];
        sourceAttachments = [...sourceAttachments, virtual];
        pendingAttachmentIdsRef.current.add(virtual.id);
        setAttachments(selectedAttachments.slice(-configuredBootstrap.uploads.max_files_per_message));
        const labels = { summarize: "Summarize", analyze: "Analyze", ask_questions: "Answer questions about", rewrite: "Rewrite", translate: "Translate" };
        providerText = `${labels[longInputMode]} the attached pasted text. Preserve its meaning and cite the supplied chunk labels when useful.`;
      } catch (caught) {
        if (!isCurrentTransport()) return;
        setError((caught as Error).message || "Large text upload failed.");
        activeRequestRef.current = null;
        transportAttemptRef.current = null;
        return;
      } finally { finishBusyOperation(preparationOperation!); }
    }
    const computedPayload: ChatRequestPayload = {
      request_id: id, message: providerText, ...(threadId && threadId !== "new-thread" ? { thread_id: threadId } : {}),
      attachment_ids: selectedAttachments.map(item => item.id), ...(canChatWithRepository(bootstrap!.features) && repositoryId && repositoryMeta && repositoryUsable({ ...repositoryMeta, owner_uid: repositoryOwnerUid || "", thread_id: repositoryThreadId }, user.uid, activeThread) ? { repository_id: repositoryId } : {}),
      input_mode: options.inputMode ?? (draftVoiceTurnId ? "dictation" : (originalForRevision?.input_mode ?? "text")),
      ...((options.voiceTurnId === undefined ? (draftVoiceTurnId ?? originalForRevision?.voice_turn_id) : options.voiceTurnId) ? { voice_turn_id: options.voiceTurnId === undefined ? (draftVoiceTurnId ?? originalForRevision?.voice_turn_id)! : options.voiceTurnId! } : {}),
      ...(mutation.continueId ? { continue_message_id: mutation.continueId } : {}),
      ...(mutation.editId ? { edit_message_id: mutation.editId } : {}),
      ...(mutation.regenerateId ? { regenerate_message_id: mutation.regenerateId } : {}),
    };
    const payload: ChatRequestPayload = options.payloadOverride
      ? { ...options.payloadOverride, request_id: id }
      : computedPayload;
    providerText = payload.message;
    selectedAttachments = sourceAttachments.filter(item => payload.attachment_ids?.includes(item.id));
    submittedPayloadsRef.current.set(id, payload);
    const submittedPendingIds = new Set(
      selectedAttachments.map(item => item.id).filter(idValue => pendingAttachmentIdsRef.current.has(idValue)),
    );
    draftRef.current = "";
    setDraft(""); setDraftVoiceTurnId(null); setEditTarget(null); setError(""); setStreaming(true); setRequestId(id);
    activeRequestRef.current = id;
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
      created_at: nowIso(), input_mode: options.inputMode ?? (draftVoiceTurnId ? "dictation" : (originalForRevision?.input_mode ?? "text")), voice_turn_id: options.voiceTurnId === undefined ? (draftVoiceTurnId ?? originalForRevision?.voice_turn_id ?? null) : options.voiceTurnId, reply_language: bootstrap?.user.reply_language || "en",
    }});
    if (!revisionTarget && !options.continueId) setMessages(value => [
      ...value.filter(item => !(item.role === "user" && item.request_id === id)),
      { ...makeUserMessage(providerText || `Attached: ${selectedAttachments.map(item => item.name).join(", ")}`, id, threadId, selectedAttachments), content: providerText || `Attached: ${selectedAttachments.map(item => item.name).join(", ")}`, input_mode: options.inputMode ?? (draftVoiceTurnId ? "dictation" : "text"), voice_turn_id: options.voiceTurnId === undefined ? draftVoiceTurnId : options.voiceTurnId, reply_language: bootstrap?.user.reply_language || "en" },
    ]);
    const controller = new AbortController(); controllerRef.current = controller;
    try {
      await streamChat(user, payload, {
        onAccepted: () => {
          if (!isCurrentTransport()) return;
          cancellationReadyRef.current = true;
          setCancellationReady(true);
          if (queuedStopRef.current) {
            queuedStopRef.current = false;
            void requestServerCancellation(id, controller);
          }
          if (revisionTarget && originalForRevision) {
            setMessages(value => [...value.filter(item => item.request_id !== revisionTarget.request_id), {
              ...originalForRevision,
              id: `pending-${id}`,
              content: providerText,
              request_id: id,
              status: "pending",
              created_at: nowIso(),
              attachments: selectedAttachments,
              input_mode: options.inputMode ?? (draftVoiceTurnId ? "dictation" : originalForRevision.input_mode),
              voice_turn_id: options.voiceTurnId === undefined ? (draftVoiceTurnId ?? originalForRevision.voice_turn_id) : options.voiceTurnId,
              replaces_message_id: revisionTarget.id,
              revision_number: (originalForRevision.revision_number || 1) + 1,
            }]);
          }
        },
        onEvent: event => { if (isCurrentTransport()) applyStreamEvent(event); },
      }, controller.signal);
      if (!isCurrentTransport()) return;
      if (submittedPendingIds.size) {
        submittedPendingIds.forEach(idValue => pendingAttachmentIdsRef.current.delete(idValue));
        // Keep the valid upload in the active thread context for follow-ups;
        // only its pending-composer classification is cleared.
      }
      if (activeThread || streamedThreadRef.current) {
        const resolved = activeThread || streamedThreadRef.current;
        if (resolved) await reloadMessages(resolved);
      }
      if (!isCurrentTransport()) return;
      await reloadThreads(false);
      if (!isCurrentTransport()) return;
      const refreshedBootstrap = await getBootstrap(user);
      if (!isCurrentTransport()) return;
      setBootstrap(refreshedBootstrap);
    } catch (caught) {
      if (!isCurrentTransport()) return;
      if ((caught as { name?: string }).name === "AbortError" && stopConfirmedRef.current) {
        setStream(previous => reduceSwicoStream(previous, { event: "done", data: { cancelled: true } }));
        setError("Generation stopped. Partial measured usage may already have been charged.");
        const resolved = activeThread || streamedThreadRef.current;
        if (resolved) await reloadMessages(resolved).catch(() => undefined);
      } else if ((caught as { name?: string }).name !== "AbortError") {
        const apiError = caught as Partial<SwicoApiError>;
        if (apiError.status === 402 && apiError.code !== "usage_limit_reached") {
          const bucket = apiError.credit_bucket === "voice" || apiError.credit_bucket === "chat" ? apiError.credit_bucket : null;
          if (bucket) { setBillingBucket(bucket); setBilling(true); }
        }
        if (apiError.code === "usage_limit_reached") {
          const resetAt = apiError.reset_at ? new Date(apiError.reset_at).toLocaleString() : "the next monthly reset";
          setError(`Your monthly usage limit has been reached. It resets at ${resetAt}. Add-token credits do not change this limit.`);
        } else if (repositoryDetachCode(apiError.code || "")) { setRepositoryId(undefined); setRepositoryMeta(null); setRepositoryThreadId(null); setError("The active code repository is no longer attached. Upload it again to continue using repository context."); }
        else setError(apiError.message || "Swico could not complete that response.");
        if (!draftRef.current.trim() && text) { draftRef.current = text; setDraft(text); }
        if (apiError.status === 410 || apiError.code === "attachment_expired") {
          setAttachments(value => value.map(item => selectedAttachments.some(selected => selected.id === item.id) ? { ...item, status: "expired" as const } : item));
          setError("An attachment expired before it could be read. Remove it and upload it again, then retry.");
        }
      }
    } finally {
      if (!isCurrentTransport()) return;
      cancellationReadyRef.current = false;
      queuedStopRef.current = false;
      cancellationSentRef.current = false;
      stopConfirmedRef.current = false;
      setCancellationReady(false);
      if (activeRequestRef.current === id) { activeRequestRef.current = null; controllerRef.current = null; setStreaming(false); setRequestId(null); }
      transportAttemptRef.current = null;
    }
  }, [activeThread, applyStreamEvent, attachments, bootstrap, draft, draftVoiceTurnId, editTarget, longInputMode, messages, offline, reloadMessages, reloadThreads, repositoryId, repositoryMeta, repositoryOwnerUid, repositoryThreadId, requestServerCancellation, streaming, user]);

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
    if (!user || message.role !== "assistant" || message.status !== "complete" || !message.voice_turn_id || !bootstrap?.features.web_voice_reply || !bootstrap.features.web_voice_billing) return;
    if (bootstrap.assistant.tier === "free") {
      setError("Swico Free is text only. Switch tiers to hear a reply.");
      return;
    }
    try {
      const currentState = voiceReplyStates[message.id];
      const cached = voiceCacheRef.current.get(message.id);
      if (cached?.sound && currentState === "playing") {
        await cached.sound.pauseAsync();
        setVoiceReplyStates(value => ({ ...value, [message.id]: "paused" }));
        return;
      }
      if (cached?.sound && (currentState === "paused" || currentState === "ended" || currentState === "ready")) {
        if (activeVoiceMessageRef.current && activeVoiceMessageRef.current !== message.id) {
          const previous = voiceCacheRef.current.get(activeVoiceMessageRef.current);
          await previous?.sound?.pauseAsync().catch(() => undefined);
          setVoiceReplyStates(value => ({ ...value, [activeVoiceMessageRef.current!]: "paused" }));
        }
        activeVoiceMessageRef.current = message.id;
        if (currentState === "ended") await cached.sound.setPositionAsync(0);
        await cached.sound.playAsync();
        setVoiceReplyStates(value => ({ ...value, [message.id]: "playing" }));
        return;
      }
      setVoiceReplyStates(value => ({ ...value, [message.id]: "generating" }));
      if (activeVoiceMessageRef.current && activeVoiceMessageRef.current !== message.id) {
        const previous = voiceCacheRef.current.get(activeVoiceMessageRef.current);
        await previous?.sound?.pauseAsync().catch(() => undefined);
        setVoiceReplyStates(value => ({ ...value, [activeVoiceMessageRef.current!]: "paused" }));
      }
      const audio = await synthesizeAudio(user, {
        operation_id: newSwicoRequestId(),
        message_id: message.id,
        voice_turn_id: message.voice_turn_id,
      });
      setBootstrap(value => value ? applyAuthoritativeVoiceWallet(value, audio.wallet) : value);
      const uri = `${FileSystem.cacheDirectory || ""}swico-reply-${Date.now()}.m4a`;
      await FileSystem.writeAsStringAsync(uri, audio.audio_base64, { encoding: FileSystem.EncodingType.Base64 });
      const loaded = await Audio.Sound.createAsync({ uri }, { shouldPlay: false });
      const evicted = voiceCacheRef.current.set(message.id, { uri, sound: loaded.sound });
      await Promise.all(evicted.map(async ([, entry]) => {
        await entry.sound?.unloadAsync().catch(() => undefined);
        await FileSystem.deleteAsync(entry.uri, { idempotent: true }).catch(() => undefined);
      }));
      activeVoiceMessageRef.current = message.id;
      await loaded.sound.playAsync();
      setVoiceReplyStates(value => ({ ...value, [message.id]: "playing" }));
      loaded.sound.setOnPlaybackStatusUpdate(status => {
        if (status.isLoaded && status.didJustFinish) {
          setVoiceReplyStates(value => ({ ...value, [message.id]: "ended" }));
          if (activeVoiceMessageRef.current === message.id) activeVoiceMessageRef.current = null;
        }
      });
    } catch (caught) {
      if ((caught as Partial<SwicoApiError>).status === 402) { setBillingBucket("voice"); setBilling(true); }
      setVoiceReplyStates(value => ({ ...value, [message.id]: "error" }));
      setError((caught as Error).message || "Swico could not play that reply.");
    }
  }, [bootstrap, user, voiceReplyStates]);

  useEffect(() => () => {
    const entries = voiceCacheRef.current.values();
    entries.forEach(entry => {
      void entry.sound?.unloadAsync().catch(() => undefined);
      void FileSystem.deleteAsync(entry.uri, { idempotent: true }).catch(() => undefined);
    });
    voiceCacheRef.current.clear();
  }, []);

  const threadAction = useCallback((thread: Thread) => {
    if (offline) { setError("You are offline. Chat actions are unavailable until you reconnect."); return; }
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
  }, [activeThread, archived, offline, reloadThreads, user]);

  const saveRename = useCallback(async () => {
    if (offline) { setError("You are offline. Chat actions are unavailable until you reconnect."); return; }
    if (!user || !renameTarget || !renameTitle.trim()) return;
    try {
      await patchThread(user, renameTarget.id, { title: renameTitle.trim() });
      setRenameTarget(null);
      await reloadThreads(archived);
    } catch (caught) { setError((caught as Error).message); }
  }, [archived, offline, reloadThreads, renameTarget, renameTitle, user]);

  const invalidateNavigation = () => {
    const nextGeneration = navigationGenerationRef.current + 1;
    navigationGenerationRef.current = nextGeneration;
    if (busyOperationRef.current.abandon(nextGeneration)) setUploading(false);
    threadListGenerationRef.current += 1;
    messageHistoryGenerationRef.current += 1;
    transportAttemptRef.current = null;
    controllerRef.current?.abort();
    activeRequestRef.current = null;
    pendingAttachmentIdsRef.current.clear();
    setStreaming(false);
  };
  const chooseThread = (id: string) => { invalidateNavigation(); setEditTarget(null); draftRef.current = ""; setDraft(""); setDraftVoiceTurnId(null); setHighlightMessageId(null); setRepositoryId(undefined); setRepositoryMeta(null); setRepositoryThreadId(null); setRepositoryOwnerUid(null); setAttachments([]); setActiveThread(id); setDrawer(false); clearSearch(); };
  const chooseSearchResult = (id: string, messageId: string | null) => { setPendingScrollMessageId(messageId); setPinnedToBottom(false); pinnedToBottomRef.current = false; chooseThread(id); setHighlightMessageId(messageId); };
  const newChat = () => { invalidateNavigation(); localConversationIdRef.current = `new-${newSwicoRequestId()}`; setEditTarget(null); draftRef.current = ""; setDraft(""); setDraftVoiceTurnId(null); setHighlightMessageId(null); setActiveThread(null); setMessages([]); setAttachments([]); setRepositoryId(undefined); setRepositoryMeta(null); setRepositoryThreadId(null); setRepositoryOwnerUid(null); setDrawer(false); clearSearch(); };

  const beginBusyOperation = (navigationGeneration: number): SwicoBusyOperation | null => {
    const operation = busyOperationRef.current.tryBegin(navigationGeneration);
    if (!operation) return null;
    setUploading(true);
    return operation;
  };
  const finishBusyOperation = (operation: SwicoBusyOperation) => {
    if (busyOperationRef.current.finish(operation)) setUploading(false);
  };

  const downloadResponse = useCallback(async (message: Message) => {
    try {
      const uri = `${FileSystem.cacheDirectory || ""}swico-response-${message.id}.md`;
      await FileSystem.writeAsStringAsync(uri, message.content, { encoding: FileSystem.EncodingType.UTF8 });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: "text/markdown", UTI: "net.daringfireball.markdown" });
      else await Share.share({ message: message.content, title: "Swico response" });
    } catch (caught) { setError((caught as Error).message || "The response could not be downloaded."); }
  }, []);

  const pickDocument = useCallback(async () => {
    const uploadNavigation = navigationGenerationRef.current;
    const uploadThread = activeThreadRef.current;
    const uploadIsCurrent = () => (
      navigationGenerationRef.current === uploadNavigation
      && activeThreadRef.current === uploadThread
      && activeRequestRef.current === null
    );
    if (offline) { setError("You are offline. Reconnect before uploading files."); return; }
    if (!user || !bootstrap || !canUseAttachments(bootstrap.features)) return;
    let busyOperation: SwicoBusyOperation | null = null;
    try {
      busyOperation = beginBusyOperation(uploadNavigation);
      if (!busyOperation) return;
      const result = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
      if (!uploadIsCurrent() || result.canceled || !result.assets[0]) return;
      const file = result.assets[0];
      const limits = bootstrap.uploads;
      const extension = `.${file.name.split(".").pop()?.toLowerCase() || ""}`;
      const isImage = String(file.mimeType || "").startsWith("image/");
      const size = Number(file.size || 0);
      const currentFiles = attachmentsRef.current.filter(item => item.status === "ready");
      const currentBytes = currentFiles.reduce((sum, item) => sum + item.size_bytes, 0);
      const currentImages = currentFiles.filter(item => item.media_type.startsWith("image/")).length;
      const perFileLimit = isImage ? (limits.image_max_file_bytes || limits.max_file_bytes) : limits.max_file_bytes;
      if (!limits.supported_extensions.map(value => value.toLowerCase()).includes(extension)) { setError(`This file type is not supported. Use ${limits.supported_extensions.join(", ")}.`); return; }
      if (size <= 0 || size > perFileLimit) { setError("This file exceeds the configured upload limit."); return; }
      if (currentFiles.length >= limits.max_files_per_message || currentBytes + size > limits.max_total_bytes) { setError("The attachment limits for this message have been reached."); return; }
      if (isImage && (!limits.image_uploads_enabled || !bootstrap.features.web_image_uploads)) { setError("Image uploads are not enabled for this account."); return; }
      if (isImage && currentImages >= (limits.image_max_count || 4)) { setError(`You can attach up to ${limits.image_max_count || 4} images.`); return; }
      const attachment = await uploadDocument(user, { uri: file.uri, name: file.name, type: file.mimeType || "application/octet-stream" }, progress => {
        if (uploadIsCurrent()) setError(progress < 100 ? `Uploading attachment · ${progress}%` : "");
      });
      if (!uploadIsCurrent()) {
        await deleteUpload(user, (attachment as Attachment).id).catch(() => undefined);
        return;
      }
      const admitted = appendWithinSwicoAttachmentCapacity(
        attachmentsRef.current,
        attachment as Attachment,
        limits,
      );
      if (admitted.error) {
        await deleteUpload(user, (attachment as Attachment).id).catch(() => undefined);
        if (uploadIsCurrent() && busyOperation && busyOperationRef.current.canPublish(
          busyOperation, navigationGenerationRef.current,
        )) {
          setError(admitted.error);
        }
        return;
      }
      pendingAttachmentIdsRef.current.add((attachment as Attachment).id);
      const nextAttachments = admitted.attachments.map(item => item.id === (attachment as Attachment).id
        ? { ...item, local_uri: isImage ? file.uri : undefined }
        : item);
      attachmentsRef.current = nextAttachments;
      setAttachments(nextAttachments);
    } catch (caught) { if (uploadIsCurrent()) setError((caught as Error).message || "Upload failed."); }
    finally { if (busyOperation) finishBusyOperation(busyOperation); }
  }, [bootstrap, offline, user]);

  const removeRepository = useCallback(async () => {
    if (!repositoryId) return;
    const id = repositoryId;
    setRepositoryId(undefined);
    setRepositoryMeta(null);
    setRepositoryThreadId(null);
    setRepositoryOwnerUid(null);
    if (offline) return;
    try { await deleteRepository(user!, id); } catch { setError("The repository was removed locally, but the server could not be reached."); }
  }, [offline, repositoryId, user]);

  const saveAttachmentToKnowledge = useCallback(async (id: string) => {
    if (offline) { setError("You are offline. Reconnect before changing Knowledge Library."); return; }
    try { await approveKnowledge(user!, id); setAttachments(value => value.filter(item => item.id !== id)); }
    catch (caught) { setError((caught as Error).message || "The document could not be saved to Knowledge Library."); }
  }, [offline, user]);

  const pickRepository = useCallback(async () => {
    const uploadNavigation = navigationGenerationRef.current;
    const uploadThread = activeThreadRef.current;
    const uploadIsCurrent = () => (
      navigationGenerationRef.current === uploadNavigation
      && activeThreadRef.current === uploadThread
      && activeRequestRef.current === null
    );
    if (offline) { setError("You are offline. Reconnect before uploading a repository."); return; }
    if (!user || !bootstrap || !canUploadRepository(bootstrap.features) || !bootstrap.repositories) return;
    let busyOperation: SwicoBusyOperation | null = null;
    try {
      busyOperation = beginBusyOperation(uploadNavigation);
      if (!busyOperation) return;
      const result = await DocumentPicker.getDocumentAsync({ type: "application/zip", copyToCacheDirectory: true });
      if (!uploadIsCurrent() || result.canceled || !result.assets[0]) return;
      const file = result.assets[0];
      if (!file.name.toLowerCase().endsWith(".zip")) { setError("Select a ZIP archive for the code repository."); return; }
      if (!file.size || file.size <= 0) { setError("The repository ZIP is empty."); return; }
      if (file.size > bootstrap.repositories.max_archive_bytes) { setError("The repository ZIP exceeds the configured upload limit."); return; }
      const previousId = repositoryId;
      const repository = await uploadRepository(user, { uri: file.uri, name: file.name, type: "application/zip" }, newSwicoRequestId(), progress => {
        if (uploadIsCurrent()) setError(progress < 100 ? `Uploading repository · ${progress}%` : "");
      });
      if (!uploadIsCurrent()) {
        await deleteRepository(user, repository.id).catch(() => undefined);
        return;
      }
      setRepositoryId(repository.id);
      setRepositoryMeta(repository);
      setRepositoryOwnerUid(user.uid);
      setRepositoryThreadId(activeThread);
      if (previousId && previousId !== repository.id) await deleteRepository(user, previousId).catch(() => setError("The replacement is ready, but the earlier temporary repository could not be cleared."));
    } catch (caught) { if (uploadIsCurrent()) setError((caught as Error).message || "Repository upload failed."); }
    finally { if (busyOperation) finishBusyOperation(busyOperation); }
  }, [activeThread, bootstrap, offline, repositoryId, user]);

  const startDictation = useCallback(async () => {
    const dictationNavigation = navigationGenerationRef.current;
    const dictationThread = activeThreadRef.current;
    const dictationIsCurrent = () => (
      navigationGenerationRef.current === dictationNavigation
      && activeThreadRef.current === dictationThread
      && activeRequestRef.current === null
    );
    if (offline) { setError("You are offline. Dictation needs a server connection."); return; }
    if (!user || !bootstrap || !canDictate(bootstrap.features)) { setError("Dictation is unavailable for this account."); return; }
    if (bootstrap.assistant.tier === "free") { setError("Swico Free is text only. Switch to Swico Lite, Swico, or Swico Pro for voice."); return; }
    const permission = await Audio.requestPermissionsAsync();
    if (!dictationIsCurrent()) return;
    if (!permission.granted) { setError("Microphone permission is required for dictation."); return; }
    const recording = new Audio.Recording();
    try {
      await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await recording.startAsync();
      if (!dictationIsCurrent()) {
        await recording.stopAndUnloadAsync().catch(() => undefined);
        return;
      }
      dictationRecordingRef.current = recording;
      const finish = async (cancelled: boolean) => {
        if (dictationRecordingRef.current !== recording) return;
        dictationRecordingRef.current = null;
        await recording.stopAndUnloadAsync().catch(() => undefined);
        const uri = recording.getURI();
        if (!uri) return;
        if (!cancelled) {
          const result = await transcribeAudioUri(user, { uri, name: "recording.m4a", type: "audio/mp4" }, newSwicoRequestId(), newSwicoRequestId(), bootstrap.user.reply_language);
          if (!dictationIsCurrent()) {
            void FileSystem.deleteAsync(uri, { idempotent: true });
            return;
          }
          setDraft(value => `${value}${value ? " " : ""}${result.transcript}`);
          setDraftVoiceTurnId(result.voice_turn_id);
        }
        void FileSystem.deleteAsync(uri, { idempotent: true });
      };
      Alert.alert("Dictation", "Speak now, then press Stop.", [{ text: "Cancel", style: "cancel", onPress: () => void finish(true) }, { text: "Stop", onPress: () => void finish(false) }]);
    } catch { if (dictationIsCurrent()) setError("The microphone could not start."); }
  }, [bootstrap, offline, user]);

  const openRealtimeVoice = useCallback(() => {
    if (offline) { setError("You are offline. Voice Mode needs a server connection."); return; }
    if (!bootstrap || !realtimeAvailability.enabled) {
      setError(realtimeAvailability.reason);
      return;
    }
    if (!realtimePcmAvailable()) {
      setError("Realtime Voice needs the Android PCM audio runtime.");
      return;
    }
    if (bootstrap.assistant.tier === "free") { setError("Swico Free is text only. Switch tiers for Voice Mode."); return; }
    setRealtimeVoice(true);
  }, [bootstrap, offline, realtimeAvailability]);

  const retryMessage = useCallback((message: Message) => {
    if (offline || streaming || message.status !== "retryable") return;
    const original = message.role === "user" ? message : messages.find(item => item.role === "user" && item.request_id === message.request_id);
    if (!original?.request_id) return;
    const retryAt = message.retry_at || original.retry_at;
    if (retryAt && Number.isFinite(Date.parse(retryAt)) && Date.parse(retryAt) > Date.now()) {
      setError(`Retry available in ${Math.max(1, Math.ceil((Date.parse(retryAt) - Date.now()) / 1000))} seconds.`);
      return;
    }
    const summary = `Attached: ${(original.attachments || []).map(item => item.name).join(", ")}`;
    void send(original.content === summary ? "" : original.content, {
      requestId: original.request_id,
      inputMode: original.input_mode,
      voiceTurnId: original.voice_turn_id,
      attachments: original.attachments,
      payloadOverride: submittedPayloadsRef.current.get(original.request_id),
    });
  }, [messages, offline, send, streaming]);

  const submitFeedback = useCallback(async (message: Message, rating: "up" | "down") => {
    if (!user || !bootstrap?.features.web_answer_feedback) return;
    const authenticatedUser = user;
    const previous = message.feedback_rating || null;
    setMessages(value => value.map(item => item.id === message.id ? { ...item, feedback_rating: rating } : item));
    try { await sendFeedback(authenticatedUser, message.id, rating); }
    catch { setMessages(value => value.map(item => item.id === message.id ? { ...item, feedback_rating: previous } : item)); setError("Your feedback could not be saved."); }
  }, [bootstrap?.features.web_answer_feedback, user]);

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
  const displayMessages = useMemo(() => logicalMessages.map(message => {
    if (message.role !== "assistant") return { ...message, content: editedResponses[message.id] ?? message.content };
    const provenanceEnabled = bootstrap ? responseProvenanceVisible(bootstrap.features) : false;
    const repositoryValidationEnabled = bootstrap?.features.web_repository_validation === true;
    const quality = provenanceEnabled && message.quality
      ? repositoryValidationEnabled ? message.quality : { ...message.quality, repository_validation_mode: null, checks: message.quality.checks.filter(check => !check.type.startsWith("repository_")) }
      : undefined;
    return { ...message, content: editedResponses[message.id] ?? message.content, sources: message.sources, provenance: provenanceEnabled ? message.provenance : undefined, quality };
  }), [bootstrap, editedResponses, logicalMessages]);
  const pendingAttachments = attachments.filter(item => pendingAttachmentIdsRef.current.has(item.id));
  const activeContextAttachments = attachments.filter(item => !pendingAttachmentIdsRef.current.has(item.id));
  const latestEditableId = useMemo(() => bootstrap && bootstrap.features.web_message_edit === true ? latestEditableUserId(messages, streaming) : null, [bootstrap, messages, streaming]);
  const sendable = hasSendableContent(draft, pendingAttachments, Boolean(repositoryId && repositoryMeta && repositoryUsable({ ...repositoryMeta, owner_uid: repositoryOwnerUid || "", thread_id: repositoryThreadId }, user?.uid || "", activeThread)), Boolean(bootstrap?.features.web_repository_chat));
  const attachmentsEnabled = Boolean(bootstrap && canUseAttachments(bootstrap.features));
  const repositoryUploadEnabled = Boolean(bootstrap && canUploadRepository(bootstrap.features));
  const dictationEnabled = Boolean(bootstrap && canDictate(bootstrap.features));
  const realtimeNativeAvailable = realtimeAvailability.enabled && realtimePcmAvailable();
  const voiceReplyEnabled = Boolean(bootstrap && canReplyWithVoice(bootstrap.features));

  useEffect(() => {
    if (!pendingScrollMessageId || !displayMessages.length) return;
    const index = messageIndexForSearch(displayMessages, pendingScrollMessageId);
    if (index < 0) return;
    const timer = setTimeout(() => {
      listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.42 });
      pinnedToBottomRef.current = false;
      setPinnedToBottom(false);
      setPendingScrollMessageId(null);
    }, 100);
    return () => clearTimeout(timer);
  }, [displayMessages, pendingScrollMessageId]);

  if (!user) return <Screen glow={false}><View style={styles.loading}><ActivityIndicator color={t.accent} /><Text style={styles.muted}>Loading Swico...</Text></View></Screen>;
  if (!bootstrap) return <Screen glow={false}><View style={styles.loading}>{bootstrapFailed ? <><Text style={styles.errorText}>Swico could not load your workspace.</Text><Pressable testID="swico-bootstrap-retry" onPress={() => void loadWorkspace()} style={styles.newChat}><Text style={styles.newChatText}>Retry</Text></Pressable></> : <><ActivityIndicator color={t.accent} /><Text style={styles.muted}>Loading Swico...</Text></>}</View></Screen>;
  if (legalPage) return <SwicoLegalScreen page={legalPage} onClose={() => setLegalPage(null)} />;
  const activeTitle = threads.find(item => item.id === activeThread)?.title || "New chat";
  return (
    <Screen safeArea={false} glow={false}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <Pressable testID="swico-drawer-button" onPress={() => setDrawer(true)} style={styles.iconButton} accessibilityLabel="Open chat drawer"><Ionicons name="menu" size={24} color={t.text} /></Pressable>
          <View style={styles.headerCenter}><Text style={styles.brand}>Swico</Text><Text style={styles.threadTitle} numberOfLines={1}>{activeTitle}</Text></View>
          <Pressable testID="swico-settings-button" onPress={() => setSettingsModal(true)} style={styles.iconButton} accessibilityLabel="Open settings"><Ionicons name="settings-outline" size={21} color={t.text} /></Pressable>
        </View>
        <View style={styles.balance}><Text style={styles.balanceText}>{bootstrap.wallets?.chat?.balance_display === "Unlimited" ? "Unlimited" : bootstrap.wallets?.chat?.token_estimate ? `~${tokenRangeLabel(bootstrap.wallets.chat.token_estimate)}` : "Token estimate unavailable"}</Text><Text style={styles.tierText}>{bootstrap.assistant.tier_label}</Text></View>
        {stream.phase === "queued" || stream.phase === "starting" ? <View style={styles.queueBanner}><Ionicons name="time-outline" color={t.accent} size={16} /><Text style={styles.queueText}>{stream.phase === "starting" ? "Starting..." : `Waiting · position ${stream.queuePosition ?? "—"}${stream.estimatedWaitSeconds ? ` · ~${stream.estimatedWaitSeconds}s` : ""}`}</Text></View> : null}
        {offline ? <View style={styles.offlineBanner}><Ionicons name="cloud-offline-outline" size={15} color={t.caramel} /><Text style={styles.offlineText}>Offline — reconnect to send, search, upload, or change settings.</Text></View> : null}
        {error ? <Pressable onPress={() => setError("")} style={styles.errorBanner}><Text style={styles.errorText}>{error}</Text></Pressable> : null}
        {displayMessages.length === 0 ? <View style={styles.empty}><Text style={styles.emptyTitle}>How can Swico help?</Text><Text style={styles.emptyText}>Ask a question, upload a document, or continue a conversation from the web.</Text><View style={styles.suggestions}>{["Explain something clearly", "Help me plan a project", "Summarize a document"].map(suggestion => <Pressable key={suggestion} disabled={offline} onPress={() => void send(suggestion)} style={styles.suggestion}><Text style={styles.suggestionText}>{suggestion}</Text><Ionicons name="arrow-up-outline" size={15} color={t.muted} /></Pressable>)}</View></View> : <><FlatList ref={listRef} data={displayMessages} keyExtractor={item => item.id} contentContainerStyle={styles.messages} onScrollToIndexFailed={({ index }) => listRef.current?.scrollToOffset({ offset: fallbackMessageOffset(index), animated: true })} onScroll={event => { const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent; const next = contentSize.height - (contentOffset.y + layoutMeasurement.height) < 48; pinnedToBottomRef.current = next; setPinnedToBottom(next); }} scrollEventThrottle={100} renderItem={({ item }) => { const actions = assistantActionsEnabled(item, Boolean(bootstrap.features.web_answer_feedback), voiceReplyEnabled); return <MessageRow message={item} highlighted={item.id === highlightMessageId} retryTick={retryTick} editable={item.id === latestEditableId} assistantActions={actions} voiceState={voiceReplyStates[item.id] || "idle"} onRetry={() => retryMessage(item)} onCopy={() => void Clipboard.setStringAsync(item.content)} onShare={() => void Share.share({ message: item.content })} onDownload={() => void downloadResponse(item)} onOpenEditor={() => setEditorMessage(item)} onEditResponse={() => setEditorMessage(item)} onVoice={() => void playVoice(item)} onFeedback={rating => void submitFeedback(item, rating)} onContinue={() => void send(undefined, { continueId: item.id })} onRegenerate={() => { const original = messages.find(candidate => candidate.role === "user" && candidate.request_id === item.request_id); if (original) { const prior = original.request_id ? submittedPayloadsRef.current.get(original.request_id) : undefined; const regenerateRequestId = newSwicoRequestId(); const payloadOverride = prior ? buildRegeneratePayload(prior, { content: original.content, attachments: original.attachments }, item.id, regenerateRequestId) : undefined; void send(original.content, { regenerateId: item.id, requestId: regenerateRequestId, attachments: original.attachments, payloadOverride }); } }} onEdit={() => { if (bootstrap.features.web_message_edit === true) { setDraft(item.content); setEditTarget(item.id); } }} />; }} />{!pinnedToBottom ? <Pressable onPress={() => { pinnedToBottomRef.current = true; setPinnedToBottom(true); listRef.current?.scrollToEnd({ animated: true }); }} style={styles.scrollBottom}><Ionicons name="arrow-down" size={18} color={t.text} /></Pressable> : null}</>}
        {pendingAttachments.length || activeContextAttachments.length || repositoryId ? <View style={styles.attachmentBar}>{activeContextAttachments.length ? <Text style={styles.attachmentMeta}>Active document context — included in follow-ups. Remove one to make room for another file.</Text> : null}{activeContextAttachments.map(item => <View key={`context-${item.id}`} style={styles.chip}><View><Text style={styles.chipText} numberOfLines={1}>{item.name}</Text><Text style={styles.attachmentMeta}>{item.status === "expired" ? "Expired context — no longer sent" : "Active context"}</Text></View><Pressable onPress={() => detachAttachment(item.id)} accessibilityLabel={`Remove active context ${item.name}`}><Ionicons name="close" size={14} color={t.text} /></Pressable></View>)}{pendingAttachments.map(item => <View key={item.id} style={styles.chip}>{item.local_uri ? <Image source={{ uri: item.local_uri }} style={{ width: 28, height: 28, borderRadius: 5 }} /> : null}<View><Text style={styles.chipText} numberOfLines={1}>{item.name}</Text><Text style={styles.attachmentMeta}>{item.status === "expired" ? "Expired — re-upload or remove" : item.warnings?.[0] || "Ready to send"}</Text></View>{bootstrap.features.web_knowledge_library ? <Pressable onPress={() => void saveAttachmentToKnowledge(item.id)} accessibilityLabel="Save document to Knowledge Library"><Ionicons name="bookmark-outline" size={14} color={t.accent} /></Pressable> : null}<Pressable onPress={() => detachAttachment(item.id)} accessibilityLabel={`Remove ${item.name}`}><Ionicons name="close" size={14} color={t.text} /></Pressable></View>)}{repositoryId ? <View style={styles.chip}><View><Text style={styles.chipText}>{repositoryMeta?.display_name || "Repository ready"}</Text><Text style={styles.attachmentMeta}>{repositoryMeta ? `${repositoryMeta.status} · ${repositoryMeta.file_count} files${repositoryMeta.languages?.length ? ` · ${repositoryMeta.languages.slice(0, 3).join(", ")}` : ""}` : "Ready"}</Text></View><Pressable onPress={() => void removeRepository()}><Ionicons name="close" size={14} color={t.text} /></Pressable></View> : null}</View> : null}
        <View style={[styles.composerShell, styles.composerSurface, { paddingBottom: Math.max(insets.bottom, 10) }]}>
          <View style={styles.composerTools}>{attachmentsEnabled ? <Pressable testID="swico-attachment-button" disabled={uploading || streaming} onPress={pickDocument} accessibilityLabel="Attach file"><Ionicons name="add-circle-outline" size={25} color={t.accent} /></Pressable> : null}{repositoryUploadEnabled ? <Pressable testID="swico-repository-button" disabled={uploading || streaming} onPress={pickRepository} accessibilityLabel="Attach repository"><Ionicons name="logo-github" size={21} color={t.accent} /></Pressable> : null}{dictationEnabled ? <Pressable testID="swico-dictation-button" onPress={() => void startDictation()} accessibilityLabel="Dictate"><Ionicons name="mic-outline" size={23} color={t.accent} /></Pressable> : null}<Pressable testID="swico-realtime-voice-button" disabled={!realtimeNativeAvailable} onPress={openRealtimeVoice} accessibilityLabel={realtimeNativeAvailable ? "Realtime voice" : realtimeAvailability.reason || "Realtime Voice needs the Android PCM audio runtime."} style={!realtimeNativeAvailable ? styles.sendDisabled : undefined}><Ionicons name="radio-outline" size={21} color={realtimeNativeAvailable ? t.accent : t.muted} /></Pressable><Pressable testID="swico-tier-button" onPress={() => setTierModal(true)} style={styles.tierPill}><Text style={styles.tierPillText}>{bootstrap.assistant.tier_label}</Text><Ionicons name="chevron-down" size={14} color={t.accent} /></Pressable></View>
          {!realtimeNativeAvailable ? <Text style={styles.attachmentMeta}>{realtimeAvailability.reason || "Realtime Voice needs the Android PCM audio runtime."}</Text> : null}
          {bootstrap.uploads.long_input_enabled && draft.length > (bootstrap.uploads.long_input_inline_threshold_chars || 16000) ? <View style={styles.longInputRow}><Text style={styles.attachmentMeta}>Large text action</Text>{(["summarize", "analyze", "ask_questions", "rewrite", "translate"] as const).map(mode => <Pressable key={mode} onPress={() => setLongInputMode(mode)} style={[styles.modePill, longInputMode === mode && styles.modePillSelected]}><Text style={styles.modeText}>{mode.replace("_", " ")}</Text></Pressable>)}</View> : null}
          <TextInput testID="swico-chat-input" accessibilityLabel="Swico chat input" value={draft} onChangeText={setDraft} placeholder={offline ? "Reconnect to send a message" : "Message Swico"} placeholderTextColor={t.muted} multiline maxLength={bootstrap.uploads.long_input_enabled ? (bootstrap.uploads.long_input_max_chars || 64000) : 16000} style={styles.input} editable={!offline && !streaming && !uploading} onSubmitEditing={() => void send()} blurOnSubmit={false} />
          <Pressable testID="swico-send-button" accessibilityLabel={streaming ? "Stop generation" : "Send message"} onPress={() => streaming ? void stop() : void send()} disabled={offline || uploading || (!streaming && !sendable)} accessibilityState={{ disabled: offline || uploading || (!streaming && !sendable) }} style={[styles.sendButton, (offline || uploading || (!streaming && !sendable)) && styles.sendDisabled]}><Ionicons name={streaming ? "stop" : "arrow-up"} size={20} color={t.accentText} /></Pressable>
        </View>
      </KeyboardAvoidingView>
      <Drawer visible={drawer} onClose={() => { setDrawer(false); clearSearch(); }} userName={bootstrap.user.name} userEmail={bootstrap.user.email} threads={threads} hasMore={hasMoreThreads} onLoadMore={() => void loadMoreThreads()} archived={archived} setArchived={value => { setArchived(value); void reloadThreads(value); }} active={activeThread} onSelect={chooseThread} onSelectSearch={chooseSearchResult} onNew={newChat} onActions={threadAction} search={search} setSearch={updateSearch} results={searchResults} wallet={bootstrap.wallets?.chat || bootstrap.wallet} offline={offline} onBilling={() => { if (offline) { setError("You are offline. Reconnect before adding tokens."); return; } setBillingBucket("chat"); setBilling(true); setDrawer(false); }} onSettings={() => { setSettingsModal(true); setDrawer(false); }} onTheme={() => void setThemePreference(themePreference === "dark" ? "light" : "dark")} onLegal={setLegalPage} onSignOut={() => void signOutUser()} />
      <TierModal visible={tierModal} onClose={() => setTierModal(false)} bootstrap={bootstrap} onChoose={async tier => { try { const assistant = await updateAssistant(user, tier); setBootstrap(value => value ? { ...value, assistant } : value); setTierModal(false); } catch (caught) { setError((caught as Error).message); } }} />
      <SwicoSettings visible={settingsModal} onClose={() => setSettingsModal(false)} user={user} bootstrap={bootstrap} onBootstrap={setBootstrap} offline={offline} onBilling={() => { if (!offline) { setBillingBucket("chat"); setBilling(true); } }} onLegal={setLegalPage} onArchived={() => { setSettingsModal(false); setArchived(true); setDrawer(true); void reloadThreads(true); }} />
      <SwicoBilling visible={billing} close={() => setBilling(false)} user={user} config={bootstrap.billing} initialBucket={billingBucket} offline={offline} refreshed={async () => { setBootstrap(await getBootstrap(user)); }} />
      <RealtimeVoiceModal visible={realtimeVoice} onClose={() => setRealtimeVoice(false)} user={user} threadId={activeThread} onRefresh={() => { if (activeThread) void reloadMessages(activeThread); void reloadThreads(false); }} onAddCredits={() => { setRealtimeVoice(false); setBillingBucket("voice"); setBilling(true); }} />
      <ResponseEditorModal message={editorMessage} originalContent={editorMessage ? messages.find(item => item.id === editorMessage.id)?.content ?? editorMessage.content : undefined} initialContent={editorMessage ? editedResponses[editorMessage.id] : undefined} onClose={() => setEditorMessage(null)} onApply={(content) => { if (!editorMessage) return; setEditedResponses(value => ({ ...value, [editorMessage.id]: content })); }} />
      <Modal visible={Boolean(renameTarget)} transparent animationType="fade" onRequestClose={() => setRenameTarget(null)}><View style={styles.modalScrim}><View style={styles.renameCard}><Text style={styles.sheetTitle}>Rename chat</Text><TextInput autoFocus value={renameTitle} onChangeText={setRenameTitle} style={styles.settingsInput} placeholder="Chat name" placeholderTextColor={t.muted} /><View style={styles.renameActions}><Pressable onPress={() => setRenameTarget(null)}><Text style={styles.tab}>Cancel</Text></Pressable><Pressable onPress={() => void saveRename()} style={styles.saveButton}><Text style={styles.saveText}>Save</Text></Pressable></View></View></View></Modal>
    </Screen>
  );
}

function MessageRow({ message, highlighted, retryTick: _retryTick, editable = false, assistantActions, voiceState = "idle", onRetry, onCopy, onShare, onDownload, onOpenEditor, onEditResponse, onVoice, onFeedback, onContinue, onRegenerate, onEdit }: { message: Message; highlighted?: boolean; retryTick?: number; editable?: boolean; assistantActions: { completed: boolean; feedback: boolean; voice: boolean }; voiceState?: VoiceReplyState; onRetry: () => void; onCopy: () => void; onShare: () => void; onDownload: () => void; onOpenEditor: () => void; onEditResponse: () => void; onVoice: () => void; onFeedback: (rating: "up" | "down") => void; onContinue: () => void; onRegenerate: () => void; onEdit: () => void }) {
  const { palette: t } = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const assistant = message.role === "assistant";
  const retryState = retryAvailability(message);
  const retryAt = message.retry_at ? Date.parse(message.retry_at) : NaN;
  const retryBlocked = retryState.blocked;
  const voiceIcon = voiceState === "generating" ? "hourglass-outline" : voiceState === "playing" ? "pause-outline" : "volume-medium-outline";
  return <View testID={assistant ? "swico-assistant-message" : "swico-user-message"} style={[styles.messageRow, assistant ? styles.assistantRow : styles.userRow]}><View style={[styles.messageCard, assistant ? styles.assistantCard : styles.userCard, highlighted && { borderColor: t.accent, borderWidth: 2 }]}>{assistant ? <MarkdownText value={message.content || "…"} /> : <Text style={styles.userText}>{message.content}</Text>}{assistant && message.provenance?.length ? <ProvenancePanel values={message.provenance} /> : null}{message.status === "retryable" ? <Pressable disabled={retryBlocked} onPress={onRetry} style={[styles.retryButton, retryBlocked && styles.sendDisabled]}><Ionicons name="refresh-outline" size={15} color={t.caramel} /><Text style={styles.retryText}>{retryBlocked ? `Retry in ${Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))}s` : "Retry"}</Text></Pressable> : null}{assistant && message.sources?.length ? <SourcesPanel sources={message.sources} /> : null}{assistant && message.quality ? <QualityPanel quality={message.quality} /> : null}{assistant && assistantActions.completed && message.truncated && message.can_continue ? <Pressable onPress={onContinue} style={styles.continueButton}><Text style={styles.continueText}>Continue generating</Text></Pressable> : null}{assistant && assistantActions.completed ? <View style={styles.messageActions}><Pressable onPress={onCopy} accessibilityLabel="Copy message"><Ionicons name="copy-outline" size={16} color={t.muted} /></Pressable><Pressable onPress={onEditResponse} accessibilityLabel="Edit response"><Ionicons name="pencil-outline" size={16} color={t.muted} /></Pressable><Pressable onPress={onDownload} accessibilityLabel="Download response"><Ionicons name="download-outline" size={16} color={t.muted} /></Pressable><Pressable onPress={onOpenEditor} accessibilityLabel="Open response editor"><Ionicons name="reader-outline" size={16} color={t.muted} /></Pressable><Pressable onPress={onShare} accessibilityLabel="Share response"><Ionicons name="share-outline" size={16} color={t.muted} /></Pressable>{assistantActions.voice ? <Pressable onPress={onVoice} accessibilityLabel={voiceState === "generating" ? "Generating voice reply" : voiceState === "playing" ? "Pause voice reply" : voiceState === "ended" ? "Replay voice reply" : "Play voice reply"}><Ionicons name={voiceIcon} size={16} color={voiceState === "error" ? t.danger : t.muted} /></Pressable> : null}<Pressable onPress={onRegenerate} accessibilityLabel="Regenerate response"><Ionicons name="refresh-outline" size={16} color={t.muted} /></Pressable>{assistantActions.feedback ? <><Pressable onPress={() => onFeedback("up")} accessibilityLabel="Good response"><Ionicons name="thumbs-up-outline" size={16} color={message.feedback_rating === "up" ? t.accent : t.muted} /></Pressable><Pressable onPress={() => onFeedback("down")} accessibilityLabel="Poor response"><Ionicons name="thumbs-down-outline" size={16} color={message.feedback_rating === "down" ? t.accent : t.muted} /></Pressable></> : null}</View> : !assistant && editable ? <View style={styles.messageActions}><Pressable onPress={onEdit} accessibilityLabel="Edit message"><Ionicons name="create-outline" size={16} color={t.muted} /></Pressable></View> : null}</View></View>;
}

function ProvenancePanel({ values }: { values: NonNullable<Message["provenance"]> }) {
  const { palette: t } = useAppTheme();
  const labels: Record<string, string> = { memory: "Used memory", document: "Used document", repository: "Repository context used", cached_answer: "Cached answer", semantic_cache: "Semantic cache", backend_tool: "Backend tool", web_search: "Web search" };
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 9 }}>{values.map(value => <View key={value} style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1, borderColor: t.line }}><Text style={{ color: t.muted, fontSize: 11 }}>{labels[value] || value.replace(/_/g, " ")}</Text></View>)}</View>;
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

function ResponseEditorModal({ message, originalContent, initialContent, onClose, onApply }: { message: Message | null; originalContent?: string; initialContent?: string; onClose: () => void; onApply: (content: string) => void }) {
  const { palette: t } = useAppTheme();
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [draft, setDraft] = useState("");
  useEffect(() => { if (message) { setDraft(initialContent ?? message.content); setMode("preview"); } }, [initialContent, message]);
  return <Modal visible={Boolean(message)} transparent animationType="slide" onRequestClose={onClose}><View style={{ flex: 1, backgroundColor: t.overlay, justifyContent: "flex-end" }}><View style={{ maxHeight: "92%", backgroundColor: t.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18, gap: 12 }}><View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}><Text style={{ color: t.text, fontSize: 20, fontWeight: "800" }}>Response editor</Text><Pressable onPress={onClose}><Ionicons name="close" size={22} color={t.text} /></Pressable></View><Text style={{ color: t.muted, fontSize: 12 }}>Local display edit only — server conversation history stays unchanged.</Text><View style={{ flexDirection: "row", gap: 8 }}><Pressable onPress={() => setMode("preview")} style={[stylesEditor.tab, { backgroundColor: mode === "preview" ? t.accent : t.soft }]}><Text style={{ color: mode === "preview" ? t.accentText : t.text }}>Preview</Text></Pressable><Pressable onPress={() => setMode("source")} style={[stylesEditor.tab, { backgroundColor: mode === "source" ? t.accent : t.soft }]}><Text style={{ color: mode === "source" ? t.accentText : t.text }}>Markdown source</Text></Pressable></View>{mode === "source" ? <TextInput multiline value={draft} onChangeText={setDraft} style={{ minHeight: 250, color: t.text, backgroundColor: t.soft, borderRadius: 10, padding: 12, textAlignVertical: "top" }} /> : <ScrollView style={{ minHeight: 250 }}><MarkdownText value={draft} /></ScrollView>}<View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 10 }}><Pressable onPress={() => setDraft(originalContent ?? message?.content ?? "")}><Text style={{ color: t.muted, padding: 10 }}>Reset to original</Text></Pressable><Pressable onPress={() => { onApply(draft); onClose(); }} style={[stylesEditor.apply, { backgroundColor: t.accent }]}><Text style={{ color: t.accentText, fontWeight: "800" }}>Apply locally</Text></Pressable></View></View></View></Modal>;
}

const stylesEditor = StyleSheet.create({ tab: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8 }, apply: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 9 } });

function RealtimeVoiceModal({ visible, onClose, user, threadId, onRefresh, onAddCredits }: { visible: boolean; onClose: () => void; user: NonNullable<ReturnType<typeof useAuth>["user"]>; threadId: string | null; onRefresh: () => void; onAddCredits: (bucket: "voice") => void }) {
  const { palette: t } = useAppTheme();
  const [phase, setPhase] = useState("connecting");
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [userTranscript, setUserTranscript] = useState("");
  const [swicoTranscript, setSwicoTranscript] = useState("");
  const [audioLevel, setAudioLevel] = useState(0);
  const [retryNonce, setRetryNonce] = useState(0);
  const pulse = useRef(new Animated.Value(1)).current;
  const transportRef = useRef<SwicoRealtimeVoiceTransport | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const audioUriRef = useRef<string | null>(null);
  const audioChunksRef = useRef(new Map<number, Uint8Array>());
  const audioCodecRef = useRef<"mp3" | "linear16">("mp3");
  const audioRateRef = useRef(0);
  const audioPlayingRef = useRef(false);
  const turnDonePendingRef = useRef(false);
  const playbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pcmReadyRef = useRef<Promise<void>>(Promise.resolve());
  const finishPlayback = useCallback(() => {
    audioPlayingRef.current = false;
    void stopRealtimePcmPlayback().catch(() => undefined);
    if (turnDonePendingRef.current) { turnDonePendingRef.current = false; setPhase("listening"); }
  }, []);
  const playAudio = useCallback(async () => {
    if (audioCodecRef.current !== "mp3" || !audioChunksRef.current.size) return;
    const chunks = Array.from(audioChunksRef.current.entries()).sort(([a], [b]) => a - b).map(([, chunk]) => chunk);
    const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0; chunks.forEach(chunk => { bytes.set(chunk, offset); offset += chunk.byteLength; });
    let binary = ""; for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
    const uri = `${FileSystem.cacheDirectory || ""}swico-voice-${Date.now()}.mp3`;
    await FileSystem.writeAsStringAsync(uri, globalThis.btoa(binary), { encoding: FileSystem.EncodingType.Base64 });
    audioUriRef.current = uri;
    await soundRef.current?.unloadAsync().catch(() => undefined);
    const loaded = await Audio.Sound.createAsync({ uri }, { shouldPlay: true });
    soundRef.current = loaded.sound;
    audioPlayingRef.current = true;
    loaded.sound.setOnPlaybackStatusUpdate(status => { if (status.isLoaded && status.didJustFinish) finishPlayback(); });
  }, [finishPlayback]);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setPhase("connecting"); setError(""); setWarning(""); setUserTranscript(""); setSwicoTranscript(""); setAudioLevel(0);
    turnDonePendingRef.current = false;
    void createVoiceSession(user, { browser_capabilities: { web_audio: false, media_source: false, media_source_mp3: false } }).then(async session => {
      if (!alive) return;
      const transport = new SwicoRealtimeVoiceTransport(session, { onJson: message => {
        if (!alive) return;
        const type = String(message.type || "");
        if (type === "state.changed") {
          const next = String(message.state || "");
          if (["connecting", "listening", "endpoint_pending", "thinking", "speaking", "interrupted", "closing", "error", "closed"].includes(next)) setPhase(next);
        } else if (type === "session.ready") setPhase("connecting");
        else if (type === "stt.partial") setUserTranscript(String(message.transcript ?? ""));
        else if (type === "stt.final") { setUserTranscript(String(message.transcript ?? "")); setPhase("thinking"); }
        else if (type === "assistant.start") { setSwicoTranscript(""); setPhase("thinking"); }
        else if (type === "assistant.delta") setSwicoTranscript(value => `${value}${String(message.delta ?? "")}`);
        else if (type === "audio.level" && typeof message.level === "number") setAudioLevel(Math.max(0, Math.min(1, message.level)));
        else if (type === "audio.start") {
          const validated = validateRealtimeAudioStart(message);
          if (!validated.ok) { setError(validated.reason); setPhase("error"); return; }
          audioChunksRef.current = new Map(); audioCodecRef.current = validated.value.codec; audioRateRef.current = validated.value.sample_rate || 0; audioPlayingRef.current = true; setError(""); setPhase("speaking");
          if (validated.value.codec === "linear16") {
            if (!realtimePcmPlaybackAvailable()) { setError("This Android build cannot play the negotiated PCM voice format."); setPhase("error"); return; }
            pcmReadyRef.current = startRealtimePcmPlayback(validated.value.sample_rate!).catch(caught => { if (alive) { setError((caught as Error).message || "Voice PCM playback could not start."); setPhase("error"); } });
          }
        } else if (type === "audio.end") {
          if (audioCodecRef.current === "mp3") void playAudio().catch(caught => { if (alive) { setError((caught as Error).message || "Voice audio could not be played."); setPhase("error"); } });
          else {
            const durationMs = audioRateRef.current ? Math.round(Array.from(audioChunksRef.current.values()).reduce((total, chunk) => total + chunk.byteLength, 0) / (audioRateRef.current * 2) * 1000) : 0;
            playbackTimerRef.current = setTimeout(finishPlayback, Math.max(100, durationMs + 100));
          }
        } else if (type === "warning" && message.code === "assistant_interrupted") { void soundRef.current?.stopAsync().catch(() => undefined); void stopRealtimePcmPlayback().catch(() => undefined); setWarning("Swico interrupted the spoken reply. You can continue listening."); setPhase("interrupted"); audioPlayingRef.current = false; }
        else if (type === "warning" && (message.credit_bucket === "voice" || message.code === "insufficient_voice_credit")) { setError(String(message.message || "Add Voice credits to continue Voice Mode.")); setPhase("error"); onAddCredits("voice"); }
        else if (type === "error") {
          const code = String(message.code || "voice_error");
          if (code === "insufficient_voice_credit" || message.credit_bucket === "voice") { setError(String(message.message || "Add Voice credits to continue Voice Mode.")); onAddCredits("voice"); }
          else if (code === "insufficient_chat_credit") setError("Voice Mode needs a current server session. Refresh Swico and try again.");
          else setError(String(message.message || "Realtime Voice stopped safely."));
          setPhase("error");
        } else if (type === "turn.done" && message.completion_status === "complete") {
          turnDonePendingRef.current = audioPlayingRef.current;
          setSwicoTranscript(""); onRefresh();
          if (!audioPlayingRef.current) setPhase("listening");
        } else if (type === "session.closed") { setPhase("closed"); audioPlayingRef.current = false; }
      }, onAudio: packet => {
        if (!alive || packet.byteLength <= 4) return;
        const sequence = new DataView(packet).getUint32(0);
        if (audioChunksRef.current.has(sequence)) return;
        const payload = packet.slice(4);
        audioChunksRef.current.set(sequence, new Uint8Array(payload));
        if (audioCodecRef.current === "linear16") void pcmReadyRef.current.then(() => writeRealtimePcmPlayback(payload)).catch(caught => { if (alive) { setError((caught as Error).message || "Voice PCM playback failed."); setPhase("error"); } });
      }, onError: message => alive && (setError(message), setPhase("error")), onClose: () => alive && setPhase("closed") });
      transportRef.current = transport;
      try { await transport.connect(threadId || undefined); } catch (caught) { if (alive) setError((caught as Error).message || "Realtime Voice could not start."); }
    }).catch(caught => alive && setError((caught as Error).message || "Realtime Voice could not start."));
    return () => { alive = false; if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current); void transportRef.current?.close(); transportRef.current = null; void soundRef.current?.unloadAsync().catch(() => undefined); void stopRealtimePcmPlayback().catch(() => undefined); if (audioUriRef.current) void FileSystem.deleteAsync(audioUriRef.current, { idempotent: true }); void endVoiceSession(user).catch(() => undefined); };
  }, [finishPlayback, onAddCredits, onRefresh, playAudio, retryNonce, threadId, user, visible]);
  useEffect(() => {
    if (!visible) return;
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1.08, duration: 900, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
    ]));
    animation.start();
    return () => animation.stop();
  }, [pulse, visible]);
  const displayPhase = error ? "error" : phase.replace(/\./g, " ").replace(/_/g, " ");
  return <Modal testID="swico-voice-mode" visible={visible} animationType="slide" onRequestClose={onClose}><View testID="swico-voice-mode-surface" style={{ flex: 1, backgroundColor: t.background, paddingTop: 58, paddingHorizontal: 22, paddingBottom: 28 }}><View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}><Text style={{ color: t.ink, fontSize: 25, fontWeight: "900" }}>Voice Mode</Text><Pressable testID="swico-voice-close" onPress={onClose} accessibilityLabel="End Voice"><Ionicons name="close" size={25} color={t.text} /></Pressable></View><View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 22 }}><Animated.View style={{ width: 190, height: 190, borderRadius: 100, backgroundColor: t.accentSoft, alignItems: "center", justifyContent: "center", transform: [{ scale: Animated.multiply(pulse, 1 + audioLevel * 0.2) }] }}><View style={{ width: 126, height: 126, borderRadius: 70, backgroundColor: t.accent, alignItems: "center", justifyContent: "center" }}><Ionicons name={muted ? "mic-off" : phase === "speaking" ? "volume-high" : "mic"} size={48} color={t.accentText} /></View></Animated.View><Text testID="swico-voice-status" style={{ color: error ? t.danger : t.caramel, fontWeight: "900", textTransform: "capitalize" }}>{displayPhase}</Text>{phase === "endpoint_pending" ? <Text style={{ color: t.muted, textAlign: "center" }}>Take your time. I’m listening.</Text> : null}{warning ? <Text style={{ color: t.caramel, textAlign: "center" }}>{warning}</Text> : null}{error ? <Text style={{ color: t.danger, textAlign: "center" }}>{error}</Text> : null}{userTranscript ? <View style={{ width: "100%", backgroundColor: t.soft, borderRadius: 14, padding: 14 }}><Text style={{ color: t.muted, fontSize: 11 }}>You</Text><Text style={{ color: t.text, marginTop: 5 }}>{userTranscript}</Text></View> : null}{swicoTranscript ? <View style={{ width: "100%", backgroundColor: t.accentSoft, borderRadius: 14, padding: 14 }}><Text style={{ color: t.caramel, fontSize: 11 }}>Swico</Text><Text style={{ color: t.text, marginTop: 5 }}>{swicoTranscript}</Text></View> : null}</View><View style={{ flexDirection: "row", justifyContent: "center", gap: 12 }}><Pressable testID="swico-voice-mute" onPress={() => { const next = !muted; setMuted(next); transportRef.current?.mute(next); }} style={{ minWidth: 112, padding: 14, borderRadius: 14, backgroundColor: t.soft, alignItems: "center" }}><Ionicons name={muted ? "mic" : "mic-off"} size={19} color={t.text} /><Text style={{ color: t.text, marginTop: 5 }}>{muted ? "Unmute" : "Mute"}</Text></Pressable>{error ? <Pressable testID="swico-voice-retry" onPress={() => { setError(""); setWarning(""); setRetryNonce(value => value + 1); }} style={{ minWidth: 112, padding: 14, borderRadius: 14, backgroundColor: t.accent, alignItems: "center" }}><Ionicons name="refresh" size={19} color={t.accentText} /><Text style={{ color: t.accentText, marginTop: 5, fontWeight: "800" }}>Retry</Text></Pressable> : <Pressable testID="swico-voice-end" onPress={onClose} style={{ minWidth: 112, padding: 14, borderRadius: 14, backgroundColor: t.danger, alignItems: "center" }}><Ionicons name="stop" size={19} color={t.accentText} /><Text style={{ color: t.accentText, fontWeight: "800" }}>End Voice</Text></Pressable>}</View></View></Modal>;
}

function Drawer({ visible, onClose, userName, userEmail, threads, hasMore, onLoadMore, active, onSelect, onSelectSearch, onNew, onActions, archived, setArchived, search, setSearch, results, wallet, offline, onBilling, onSettings, onTheme, onLegal, onSignOut }: { visible: boolean; onClose: () => void; userName: string; userEmail: string | null; threads: Thread[]; hasMore: boolean; onLoadMore: () => void; active: string | null; onSelect: (id: string) => void; onSelectSearch: (id: string, messageId: string | null) => void; onNew: () => void; onActions: (thread: Thread) => void; archived: boolean; setArchived: (value: boolean) => void; search: string; setSearch: (value: string) => void; results: SearchResult[]; wallet: Bootstrap["wallet"]; offline: boolean; onBilling: () => void; onSettings: () => void; onTheme: () => void; onLegal: (page: string) => void; onSignOut: () => void }) {
  const { palette: t } = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const groups = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"].map(label => ({ label, items: threads.filter(thread => { const days = Math.floor((Date.now() - new Date(thread.updated_at).setHours(0, 0, 0, 0)) / 86400000); return label === "Today" ? days <= 0 : label === "Yesterday" ? days === 1 : label === "Previous 7 days" ? days > 1 && days <= 7 : label === "Previous 30 days" ? days > 7 && days <= 30 : days > 30; }) })).filter(group => group.items.length);
  const resultGroups = (["message", "summary", "memory"] as const).map(kind => ({ kind, items: results.filter(item => item.source_kind === kind) })).filter(group => group.items.length);
  const creditText = wallet.balance_display === "Unlimited" ? "Unlimited" : wallet.token_estimate ? `~${tokenRangeLabel(wallet.token_estimate)}` : "Balance estimate unavailable";
  const [accountMenu, setAccountMenu] = useState(false);
  const accountInitial = (userName.trim() || userEmail || "S").slice(0, 1).toUpperCase();
  return <Modal testID="swico-drawer" visible={visible} animationType="slide" transparent onRequestClose={onClose}><View style={styles.modalScrim}><View style={styles.drawer}><View style={styles.drawerHeader}><Text style={styles.drawerTitle}>Swico</Text><Pressable testID="swico-drawer-close" onPress={onClose}><Ionicons name="close" size={24} color={t.ink} /></Pressable></View><Pressable testID="swico-new-chat" disabled={offline} onPress={onNew} style={[styles.newChat, offline && styles.sendDisabled]}><Ionicons name="add" size={20} color={t.accentText} /><Text style={styles.newChatText}>New chat</Text></Pressable><TextInput testID="swico-search-input" accessibilityLabel="Search chats" value={search} onChangeText={setSearch} editable={!offline} placeholder="Search chats" placeholderTextColor={t.muted} style={styles.searchInput} />{resultGroups.length ? <View style={styles.resultGroups}>{resultGroups.map(group => <View key={group.kind}><Text style={styles.resultHeading}>{group.kind === "message" ? "Messages" : group.kind === "summary" ? "Chat summaries" : "Saved memory"}</Text>{group.items.map((item, index) => <Pressable key={`${item.thread_id}-${item.message_id}-${index}`} disabled={!item.thread_id || offline} onPress={() => item.thread_id && onSelectSearch(item.thread_id, item.message_id)} style={styles.searchResult}><Text style={styles.threadText} numberOfLines={2}>{item.snippet}</Text><Text style={styles.resultDate}>{new Date(item.updated_at).toLocaleDateString()}</Text></Pressable>)}</View>)}</View> : null}<View style={styles.archiveTabs}><Pressable testID="swico-chats-tab" onPress={() => setArchived(false)}><Text style={!archived ? styles.activeTab : styles.tab}>Chats</Text></Pressable><Pressable testID="swico-archived-tab" onPress={() => setArchived(true)}><Text style={archived ? styles.activeTab : styles.tab}>Archived</Text></Pressable></View><ScrollView style={styles.threadList}>{groups.map(group => <View key={group.label}><Text style={styles.resultHeading}>{group.label}</Text>{group.items.map(thread => <View key={thread.id} style={[styles.threadItem, thread.id === active && styles.threadActive]}><Pressable disabled={offline} onPress={() => onSelect(thread.id)} style={styles.threadMain}><Ionicons name="chatbubble-outline" size={17} color={t.muted} /><Text style={styles.threadText} numberOfLines={1}>{thread.title || "New chat"}</Text></Pressable><Pressable disabled={offline} onPress={() => onActions(thread)} accessibilityLabel={`Actions for ${thread.title || "chat"}`}><Ionicons name="ellipsis-horizontal" size={18} color={t.muted} /></Pressable></View>)}</View>)}{hasMore ? <Pressable disabled={offline} onPress={onLoadMore} style={styles.loadMore}><Text style={styles.closeText}>Load more</Text></Pressable> : null}</ScrollView><Pressable testID="swico-token-credits" disabled={offline} onPress={onBilling} style={[styles.creditCard, offline && styles.sendDisabled]}><View><Text style={styles.creditTitle}>Token credits</Text><Text style={styles.creditText}>{creditText}</Text></View><Ionicons name="add-circle-outline" size={22} color={t.accent} /></Pressable><View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10, padding: 10, borderRadius: 12, backgroundColor: t.soft }}><View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: t.accent, alignItems: "center", justifyContent: "center" }}><Text style={{ color: t.accentText, fontWeight: "900" }}>{accountInitial}</Text></View><View style={{ flex: 1 }}><Text style={styles.threadText} numberOfLines={1}>{userName || "Swico account"}</Text><Text style={styles.resultDate} numberOfLines={1}>{userEmail || "Firebase account"}</Text></View><Pressable onPress={() => setAccountMenu(value => !value)} accessibilityLabel="Open account menu"><Ionicons name={accountMenu ? "chevron-up" : "chevron-down"} size={18} color={t.muted} /></Pressable></View><Pressable testID="swico-google-sign-in" disabled={offline} onPress={() => {}} accessibilityLabel="Sign in with Google" style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8, padding: 12, borderRadius: 12, backgroundColor: t.soft }}><Ionicons name="logo-google" size={20} color="#4285F4" /><Text style={styles.threadText}>Sign in with Google</Text></Pressable>{accountMenu ? <View style={styles.accountActions}><Pressable onPress={() => { setAccountMenu(false); onSettings(); }} style={styles.accountButton}><Ionicons name="settings-outline" size={20} color={t.muted} /><Text style={styles.threadText}>Settings</Text></Pressable><Pressable onPress={onTheme} style={styles.accountButton}><Ionicons name="contrast-outline" size={20} color={t.muted} /><Text style={styles.threadText}>Toggle theme</Text></Pressable><Pressable onPress={onSignOut} style={styles.accountButton}><Ionicons name="log-out-outline" size={20} color={t.danger} /><Text style={styles.signOutText}>Sign out</Text></Pressable></View> : null}<Text style={styles.resultHeading}>Legal</Text><View style={styles.legalGrid}>{[["terms", "Terms"], ["privacy", "Privacy"], ["refunds", "Refunds"], ["ai", "AI limitations"], ["delivery", "Digital delivery"], ["pricing", "Pricing"], ["contact", "Support"]].map(([id, label]) => <Pressable testID={`swico-legal-${id}`} key={id} onPress={() => { onLegal(id); onClose(); }} style={styles.legalItem}><Text style={styles.threadText}>{label}</Text></Pressable>)}</View></View></View></Modal>;
}

function TierModal({ visible, onClose, bootstrap, onChoose }: { visible: boolean; onClose: () => void; bootstrap: Bootstrap; onChoose: (tier: string) => Promise<void> }) {
  const { palette: t } = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  return <Modal testID="swico-tier-modal" visible={visible} transparent animationType="slide" onRequestClose={onClose}><View style={styles.modalScrim}><View style={styles.sheet}><Text style={styles.sheetTitle}>Swico mode</Text><Text style={styles.settingsMeta}>Mode changes apply to your next message.</Text>{bootstrap.assistant.tiers.map(option => <Pressable testID={`swico-tier-option-${option.id}`} key={option.id} disabled={!option.available || option.selected} onPress={() => void onChoose(option.id)} style={[styles.tierOption, option.selected && styles.tierSelected, !option.available && styles.tierUnavailable]}><View style={styles.tierOptionText}><Text style={styles.tierLabel}>{option.label}</Text><Text style={styles.tierDescription}>{option.description}</Text></View>{option.selected ? <Ionicons name="checkmark-circle" size={22} color={t.caramel} /> : null}</Pressable>)}<Pressable testID="swico-tier-close" onPress={onClose} style={styles.closeSheet}><Text style={styles.closeText}>Close</Text></Pressable></View></View></Modal>;
}

function createStyles(t: Palette) { return StyleSheet.create({
  composerSurface: { backgroundColor: t.composer }, drawerSurface: { backgroundColor: t.sidebar },
  loadMore: { alignItems: "center", paddingVertical: 12 }, attachmentMeta: { color: t.muted, fontSize: 10, marginTop: 2 }, longInputRow: { flexDirection: "row", alignItems: "center", gap: 5, flexWrap: "wrap", marginBottom: 6 }, modePill: { borderRadius: 8, paddingHorizontal: 6, paddingVertical: 4, backgroundColor: t.soft }, modePillSelected: { backgroundColor: t.accent }, modeText: { color: t.text, fontSize: 10, textTransform: "capitalize" }, sheetTitle: { color: t.ink, fontSize: 22, fontWeight: "900" },
  fill: { flex: 1 }, loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }, muted: { color: t.muted }, header: { minHeight: 62, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderBottomColor: t.line }, iconButton: { width: 42, height: 42, alignItems: "center", justifyContent: "center" }, headerCenter: { flex: 1, alignItems: "center" }, brand: { color: t.ink, fontSize: 20, fontWeight: "900" }, threadTitle: { color: t.muted, fontSize: 11, maxWidth: 190 }, balance: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 18, paddingVertical: 7 }, balanceText: { color: t.muted, fontSize: 11 }, tierText: { color: t.caramel, fontSize: 11, fontWeight: "800" }, queueBanner: { marginHorizontal: 14, borderRadius: 12, backgroundColor: t.accentSoft, padding: 9, flexDirection: "row", alignItems: "center", gap: 7 }, queueText: { color: t.caramel, fontSize: 12, fontWeight: "700" }, offlineBanner: { marginHorizontal: 12, marginVertical: 6, padding: 9, borderRadius: 10, backgroundColor: t.accentSoft, flexDirection: "row", alignItems: "center", gap: 7 }, offlineText: { color: t.caramel, fontSize: 12, flex: 1 }, errorBanner: { margin: 12, padding: 10, borderRadius: 10, backgroundColor: t.dangerSoft }, errorText: { color: t.danger, fontSize: 12 }, empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }, emptyTitle: { color: t.ink, fontSize: 28, fontWeight: "900", textAlign: "center" }, emptyText: { color: t.muted, textAlign: "center", lineHeight: 21, marginTop: 10 }, suggestions: { width: "100%", gap: 8, marginTop: 22 }, suggestion: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderWidth: 1, borderColor: t.line, borderRadius: 13, padding: 12 }, suggestionText: { color: t.text, fontSize: 13 }, messages: { padding: 14, gap: 12, paddingBottom: 22 }, scrollBottom: { position: "absolute", bottom: 18, alignSelf: "center", width: 38, height: 38, borderRadius: 20, backgroundColor: t.surface, borderWidth: 1, borderColor: t.line, alignItems: "center", justifyContent: "center" }, messageRow: { width: "100%" }, assistantRow: { alignItems: "flex-start" }, userRow: { alignItems: "flex-end" }, messageCard: { maxWidth: "90%", borderRadius: 18, padding: 13 }, assistantCard: { backgroundColor: t.raised, borderWidth: 1, borderColor: t.line }, userCard: { backgroundColor: t.accent }, userText: { color: t.accentText, fontSize: 15, lineHeight: 23 }, sourceText: { color: t.caramel, fontSize: 11, marginTop: 10 }, messageActions: { flexDirection: "row", gap: 15, marginTop: 12 }, retryButton: { marginTop: 10, flexDirection: "row", alignItems: "center", gap: 5, padding: 9, backgroundColor: t.accentSoft, borderRadius: 9 }, retryText: { color: t.caramel, fontWeight: "800", fontSize: 12 }, continueButton: { marginTop: 12, padding: 9, borderRadius: 9, backgroundColor: t.accentSoft }, continueText: { color: t.caramel, fontWeight: "800", fontSize: 12 }, attachmentBar: { flexDirection: "row", gap: 7, paddingHorizontal: 14, paddingVertical: 5, flexWrap: "wrap" }, chip: { flexDirection: "row", alignItems: "center", gap: 5, maxWidth: 180, backgroundColor: t.soft, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 6 }, chipText: { color: t.text, fontSize: 11 }, composerShell: { borderTopWidth: 1, borderTopColor: t.line, paddingHorizontal: 13, paddingTop: 8, backgroundColor: t.glassStrong }, composerTools: { flexDirection: "row", alignItems: "center", gap: 16, marginBottom: 7 }, tierPill: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 3, borderWidth: 1, borderColor: t.lineStrong, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 5 }, tierPillText: { color: t.caramel, fontSize: 11, fontWeight: "800" }, input: { minHeight: 46, maxHeight: 130, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, paddingRight: 50, color: t.text, backgroundColor: t.soft, fontSize: 15 }, sendButton: { position: "absolute", right: 20, bottom: 18, width: 35, height: 35, borderRadius: 18, backgroundColor: t.bronze, alignItems: "center", justifyContent: "center" }, sendDisabled: { opacity: 0.35 }, modalScrim: { flex: 1, backgroundColor: t.overlay, justifyContent: "flex-end" }, drawer: { height: "94%", backgroundColor: t.glassStrong, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 18 }, drawerHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 15 }, drawerTitle: { color: t.ink, fontSize: 24, fontWeight: "900" }, newChat: { flexDirection: "row", alignItems: "center", gap: 9, padding: 13, borderRadius: 12, backgroundColor: t.accent }, newChatText: { color: t.accentText, fontWeight: "800" }, searchInput: { marginTop: 12, borderRadius: 12, backgroundColor: t.soft, color: t.text, padding: 12 }, searchResult: { paddingVertical: 10 }, resultGroups: { gap: 8, marginTop: 8 }, resultHeading: { color: t.caramel, fontWeight: "900", fontSize: 11, marginTop: 10, textTransform: "uppercase" }, resultDate: { color: t.muted, fontSize: 10, marginTop: 3 }, archiveTabs: { flexDirection: "row", gap: 20, borderBottomWidth: 1, borderBottomColor: t.line, paddingVertical: 16 }, tab: { color: t.muted, fontWeight: "700" }, activeTab: { color: t.caramel, fontWeight: "900" }, threadList: { flex: 1 }, threadItem: { flexDirection: "row", alignItems: "center", gap: 9, padding: 12, borderRadius: 10 }, threadMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 9 }, threadActive: { backgroundColor: t.soft }, threadText: { flex: 1, color: t.text, fontSize: 14 }, creditCard: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: t.accentSoft, padding: 13, borderRadius: 13, marginTop: 10 }, creditTitle: { color: t.text, fontWeight: "800" }, creditText: { color: t.muted, fontSize: 12, marginTop: 2 }, accountActions: { flexDirection: "row", gap: 8, marginTop: 8 }, accountButton: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: t.soft, padding: 10, borderRadius: 10 }, legalGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, legalItem: { borderWidth: 1, borderColor: t.line, borderRadius: 9, padding: 9, minWidth: "30%" }, signOut: { flexDirection: "row", gap: 8, alignItems: "center", paddingVertical: 14 }, signOutText: { color: t.danger, fontWeight: "800" }, sheet: { backgroundColor: t.glassStrong, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 18, gap: 10 }, tierOption: { flexDirection: "row", alignItems: "center", padding: 13, borderRadius: 13, borderWidth: 1, borderColor: t.line, gap: 10 }, tierSelected: { borderColor: t.caramel, backgroundColor: t.accentSoft }, tierUnavailable: { opacity: 0.45 }, tierOptionText: { flex: 1 }, tierLabel: { color: t.text, fontWeight: "900", fontSize: 15 }, tierDescription: { color: t.muted, marginTop: 3, fontSize: 12 }, closeSheet: { alignItems: "center", paddingVertical: 14 }, closeText: { color: t.caramel, fontWeight: "900" }, settings: { height: "90%", backgroundColor: t.glassStrong, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 18 }, settingsContent: { gap: 12, paddingBottom: 30 }, sectionTitle: { color: t.caramel, fontWeight: "900", fontSize: 13, marginTop: 10 }, settingsInput: { borderRadius: 12, color: t.text, padding: 12 }, settingsMeta: { color: t.muted, fontSize: 13, lineHeight: 20 }, saveButton: { alignSelf: "flex-start", backgroundColor: t.bronze, padding: 10, borderRadius: 10 }, saveText: { color: t.accentText, fontWeight: "800" }, settingRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 13, borderRadius: 12, backgroundColor: t.soft }, settingLabel: { color: t.text, fontWeight: "700" }, settingValue: { color: t.caramel, fontWeight: "900" }, renameCard: { margin: 22, padding: 18, borderRadius: 20, backgroundColor: t.glassStrong, gap: 14 }, renameActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 18 },
}); }
