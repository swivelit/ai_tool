import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import RazorpayCheckout from "react-native-razorpay";
import { Ionicons } from "@expo/vector-icons";
import type { User } from "firebase/auth";
import type { BillingConfig, CreditBucket, PaymentHistory, TopupEstimateResponse } from "@/lib/swicoTypes";
import { createBillingOrder, getBillingEstimate, getPaymentStatus, getPayments, newSwicoRequestId, verifyBillingPayment } from "@/lib/swicoApi";
import { creditBucketLabel, customTopupAmount, formatRupeesFromPaise, paymentStatusLabel, tokenRangeLabel, voiceEstimateLabel } from "@/lib/swicoBilling";
import { useAppTheme } from "@/hooks/use-app-theme";

type Props = { visible: boolean; close: () => void; user: User; config: BillingConfig; initialBucket?: CreditBucket; refreshed: () => Promise<void> | void };

export function SwicoBilling({ visible, close, user, config, initialBucket = "chat", refreshed }: Props) {
  const { palette: t } = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [bucket, setBucket] = useState<CreditBucket>(initialBucket);
  const [selected, setSelected] = useState<number | "custom">(config.packages[0]?.gross_amount_paise ?? "custom");
  const [customInput, setCustomInput] = useState("");
  const [customEstimate, setCustomEstimate] = useState<TopupEstimateResponse | null>(null);
  const [estimateLoading, setEstimateLoading] = useState(false);
  const [history, setHistory] = useState<PaymentHistory[]>([]);
  const [tab, setTab] = useState<"topup" | "history">("topup");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const pollingRef = useRef(true);
  const custom = customTopupAmount(customInput, config);
  const amount = selected === "custom" ? custom.paise : selected;
  const selectedPackage = typeof selected === "number" ? config.packages.find(item => item.gross_amount_paise === selected) : null;
  const estimate = selected === "custom" ? customEstimate : selectedPackage;
  const estimateReady = bucket === "chat" ? Boolean(estimate?.token_estimate) : Boolean(estimate?.voice_estimate);

  useEffect(() => {
    if (!visible) return;
    pollingRef.current = true;
    setBucket(initialBucket);
    setError(""); setStatus("");
    void getPayments(user).then(result => setHistory(result.items)).catch(() => setError("Payment history could not be loaded."));
    return () => { pollingRef.current = false; };
  }, [initialBucket, user, visible]);

  useEffect(() => {
    if (!visible || selected !== "custom" || custom.paise === null || custom.error || !config.custom_topup_enabled) {
      setCustomEstimate(null); setEstimateLoading(false); return;
    }
    let active = true;
    setEstimateLoading(true);
    const timer = setTimeout(() => void getBillingEstimate(user, custom.paise!, bucket).then(result => {
      if (active) setCustomEstimate(result);
    }).catch(() => { if (active) setError("Token estimate is unavailable. Try again."); }).finally(() => { if (active) setEstimateLoading(false); }), 350);
    return () => { active = false; clearTimeout(timer); };
  }, [bucket, config.custom_topup_enabled, custom.error, custom.paise, selected, user, visible]);

  const finishPending = async (orderId: string, bucketForOrder: CreditBucket) => {
    setStatus("Payment received. Waiting for secure confirmation…");
    const deadline = Date.now() + 30000;
    while (pollingRef.current && Date.now() < deadline) {
      const payment = await getPaymentStatus(user, orderId).catch(() => null);
      if (payment && ["credited", "failed", "refunded", "partially_refunded"].includes(payment.status)) {
        setHistory(value => [payment, ...value.filter(item => item.id !== payment.id)]);
        if (payment.status === "credited" || payment.credit_applied) { await refreshed(); setStatus(`${creditBucketLabel(bucketForOrder)} credits added.`); }
        else setStatus(paymentStatusLabel(payment));
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    setStatus("Confirmation is still pending. Your balance will update automatically after the payment webhook arrives.");
  };

  const checkout = async () => {
    if (busy || !config.checkout_enabled || amount === null || !estimateReady) return;
    setBusy(true); setError(""); setStatus("Creating secure order…");
    const bucketForOrder = bucket;
    try {
      const order = await createBillingOrder(user, { gross_amount_paise: amount, credit_bucket: bucketForOrder, idempotency_key: newSwicoRequestId() });
      setStatus("Opening secure payment checkout…");
      const result = await RazorpayCheckout.open({
        key: order.key_id,
        amount: order.amount,
        currency: order.currency,
        order_id: order.provider_order_id,
        name: "Swico",
        description: `Prepaid ${creditBucketLabel(bucketForOrder)} credits`,
        notes: { internal_order_id: order.internal_order_id, credit_bucket: bucketForOrder },
      });
      setStatus("Confirming payment…");
      const verified = await verifyBillingPayment(user, { internal_order_id: order.internal_order_id, ...result });
      if (verified.credited) { await refreshed(); setStatus(`${creditBucketLabel(bucketForOrder)} credits added.`); }
      else await finishPending(order.internal_order_id, bucketForOrder);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught || "");
      const cancelled = /cancel|dismiss|back/i.test(message);
      if (cancelled) setStatus("Payment cancelled — no credits were added.");
      else { setError(message || "Checkout could not be completed."); setStatus(""); }
    } finally { setBusy(false); }
  };

  return <Modal visible={visible} transparent animationType="slide" onRequestClose={() => { if (!busy) close(); }}>
    <View style={styles.scrim}><View style={styles.modal}>
      <View style={styles.heading}><View><Text style={styles.title}>Top up</Text><Text style={styles.subtitle}>Secure prepaid Token Credits</Text></View><Pressable disabled={busy} onPress={close} accessibilityLabel="Close top up"><Ionicons name="close" size={23} color={t.text} /></Pressable></View>
      <View style={styles.tabs}><Pressable onPress={() => setTab("topup")} style={[styles.tab, tab === "topup" && styles.activeTab]}><Text style={styles.tabText}>Top up</Text></Pressable><Pressable onPress={() => setTab("history")} style={[styles.tab, tab === "history" && styles.activeTab]}><Text style={styles.tabText}>Payment history</Text></Pressable></View>
      {tab === "history" ? <ScrollView contentContainerStyle={styles.content}>{!history.length ? <Text style={styles.muted}>No payments or refunds yet.</Text> : history.map(item => <View key={item.id} style={styles.historyCard}><View style={styles.row}><Text style={styles.cardTitle}>{paymentStatusLabel(item)}</Text><Text style={styles.muted}>{creditBucketLabel(item.credit_bucket ?? "chat")} credits</Text></View><Text style={styles.muted}>{formatRupeesFromPaise(item.gross_amount_paise)} · {new Date(item.created_at).toLocaleDateString()}</Text>{item.token_estimate ? <Text style={styles.muted}>Estimated tokens: {tokenRangeLabel(item.token_estimate)}</Text> : null}{item.voice_estimate ? <Text style={styles.muted}>{voiceEstimateLabel(item.voice_estimate)}</Text> : null}</View>)}</ScrollView> : <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.bucketTabs}><Pressable onPress={() => { setBucket("chat"); setCustomEstimate(null); }} style={[styles.bucket, bucket === "chat" && styles.activeBucket]}><Text style={styles.tabText}>Chat credits</Text></Pressable><Pressable onPress={() => { setBucket("voice"); setCustomEstimate(null); }} style={[styles.bucket, bucket === "voice" && styles.activeBucket]}><Text style={styles.tabText}>Voice credits</Text></Pressable></View>
        <Text style={styles.sectionLabel}>Choose an amount</Text>
        <View style={styles.packages}>{config.packages.map(item => <Pressable key={item.gross_amount_paise} onPress={() => setSelected(item.gross_amount_paise)} style={[styles.package, selected === item.gross_amount_paise && styles.selectedPackage]}><Text style={styles.packageTitle}>Pay {formatRupeesFromPaise(item.gross_amount_paise)}</Text><Text style={styles.muted}>{bucket === "chat" ? tokenRangeLabel(item.token_estimate) : voiceEstimateLabel(item.voice_estimate)}</Text></Pressable>)}{config.custom_topup_enabled ? <Pressable onPress={() => setSelected("custom")} style={[styles.package, selected === "custom" && styles.selectedPackage]}><Text style={styles.packageTitle}>Custom amount</Text><Text style={styles.muted}>Enter whole rupees</Text></Pressable> : null}</View>
        {selected === "custom" ? <View><Text style={styles.sectionLabel}>Custom amount</Text><TextInput value={customInput} onChangeText={value => { setCustomInput(value); setCustomEstimate(null); }} keyboardType="number-pad" placeholder="₹ amount" placeholderTextColor={t.placeholder} style={styles.input} /><Text style={styles.muted}>Minimum {formatRupeesFromPaise(config.min_topup_paise)} · Maximum {formatRupeesFromPaise(config.max_topup_paise)}</Text>{custom.error ? <Text style={styles.error}>{custom.error}</Text> : null}{estimateLoading ? <Text style={styles.muted}>Calculating estimate…</Text> : null}</View> : null}
        {amount !== null && estimateReady ? <View style={styles.summary}><Text style={styles.packageTitle}>Pay {formatRupeesFromPaise(amount)} for {creditBucketLabel(bucket)} credits</Text><Text style={styles.muted}>{bucket === "chat" ? `Estimated token range: ${tokenRangeLabel(estimate?.token_estimate)}` : voiceEstimateLabel(estimate?.voice_estimate)}</Text></View> : null}
        {!config.checkout_enabled ? <Text style={styles.muted}>Checkout is currently disabled. Existing credits can still be used.</Text> : null}
        <Pressable disabled={busy || amount === null || !estimateReady || !config.checkout_enabled} onPress={() => void checkout()} style={[styles.primary, (busy || amount === null || !estimateReady || !config.checkout_enabled) && styles.disabled]}>{busy ? <ActivityIndicator color={t.accentText} /> : <Text style={styles.primaryText}>{amount === null ? "Choose an amount" : `Pay ${formatRupeesFromPaise(amount)}`}</Text>}</Pressable>
        {status ? <Text style={styles.status}>{status}</Text> : null}{error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>}
    </View></View>
  </Modal>;
}

function createStyles(t: ReturnType<typeof useAppTheme>["palette"]) { return StyleSheet.create({
  scrim: { flex: 1, backgroundColor: t.overlay, justifyContent: "flex-end" }, modal: { maxHeight: "94%", backgroundColor: t.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 18 }, heading: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }, title: { color: t.text, fontSize: 24, fontWeight: "900" }, subtitle: { color: t.muted, marginTop: 3 }, tabs: { flexDirection: "row", gap: 5, backgroundColor: t.soft, padding: 4, borderRadius: 11, marginVertical: 18 }, tab: { flex: 1, padding: 9, alignItems: "center", borderRadius: 8 }, activeTab: { backgroundColor: t.surface }, tabText: { color: t.text, fontWeight: "700", fontSize: 12 }, content: { gap: 12, paddingBottom: 28 }, bucketTabs: { flexDirection: "row", gap: 8 }, bucket: { flex: 1, padding: 11, alignItems: "center", borderRadius: 11, backgroundColor: t.soft }, activeBucket: { backgroundColor: t.accent }, sectionLabel: { color: t.text, fontWeight: "800", marginTop: 5 }, packages: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, package: { width: "48%", minHeight: 74, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: t.line, backgroundColor: t.surface }, selectedPackage: { borderColor: t.accent, backgroundColor: t.accentSoft }, packageTitle: { color: t.text, fontWeight: "800" }, muted: { color: t.muted, fontSize: 12, lineHeight: 18 }, input: { color: t.text, backgroundColor: t.soft, borderRadius: 11, padding: 13, marginTop: 7 }, summary: { backgroundColor: t.accentSoft, padding: 13, borderRadius: 12, gap: 4 }, primary: { minHeight: 48, borderRadius: 12, backgroundColor: t.accent, alignItems: "center", justifyContent: "center", marginTop: 5 }, primaryText: { color: t.accentText, fontWeight: "900" }, disabled: { opacity: 0.4 }, status: { color: t.success, textAlign: "center", lineHeight: 19 }, error: { color: t.danger, lineHeight: 18 }, historyCard: { borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 12, gap: 5 }, row: { flexDirection: "row", justifyContent: "space-between", gap: 10 }, cardTitle: { color: t.text, fontWeight: "800", flex: 1 },
}); }

