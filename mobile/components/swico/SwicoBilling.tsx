import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import RazorpayCheckout from "react-native-razorpay";
import { Ionicons } from "@expo/vector-icons";
import type { User } from "firebase/auth";

import type {
  BillingConfig,
  CreditBucket,
  PaymentHistory,
  TopupEstimateResponse,
} from "@/lib/swicoTypes";

import {
  createBillingOrder,
  getBillingEstimate,
  getPaymentStatus,
  getPayments,
  newSwicoRequestId,
  verifyBillingPayment,
} from "@/lib/swicoApi";

import {
  creditBucketLabel,
  customTopupAmount,
  formatRupeesFromPaise,
  paymentStatusLabel,
  tokenRangeLabel,
  voiceEstimateLabel,
} from "@/lib/swicoBilling";

type Props = {
  visible: boolean;
  close: () => void;
  user: User;
  config: BillingConfig;
  initialBucket?: CreditBucket;
  refreshed: () => Promise<void> | void;
  offline?: boolean;
};

export function SwicoBilling({
  visible,
  close,
  user,
  config,
  initialBucket = "chat",
  refreshed,
  offline = false,
}: Props) {
  const styles = useMemo(() => createStyles(), []);

  const [bucket, setBucket] =
    useState<CreditBucket>(initialBucket);

  const [selected, setSelected] = useState<
    number | "custom"
  >(
    config.packages[0]?.gross_amount_paise ??
      "custom"
  );

  const [customInput, setCustomInput] =
    useState("");

  const [customEstimate, setCustomEstimate] =
    useState<TopupEstimateResponse | null>(null);

  const [estimateLoading, setEstimateLoading] =
    useState(false);

  const [history, setHistory] =
    useState<PaymentHistory[]>([]);

  const [tab, setTab] =
    useState<"topup" | "history">("topup");

  const [busy, setBusy] = useState(false);

  const [status, setStatus] = useState("");

  const [error, setError] = useState("");

  const [pendingOrderId, setPendingOrderId] =
    useState<string | null>(null);

  const pollingRef = useRef(true);

  const custom = customTopupAmount(
    customInput,
    config
  );

  const amount =
    selected === "custom"
      ? custom.paise
      : selected;

  const selectedPackage =
    typeof selected === "number"
      ? config.packages.find(
          (item) =>
            item.gross_amount_paise === selected
        )
      : null;

  const estimate =
    selected === "custom"
      ? customEstimate
      : selectedPackage;

  const estimateReady =
    bucket === "chat"
      ? Boolean(estimate?.token_estimate)
      : Boolean(estimate?.voice_estimate);

  /* ---------------- PAYMENT HISTORY ---------------- */

  useEffect(() => {
    if (!visible) return;

    pollingRef.current = true;

    setBucket(initialBucket);
    setError("");
    setStatus("");

    void getPayments(user)
      .then((result) =>
        setHistory(result.items)
      )
      .catch(() =>
        setError(
          "Payment history could not be loaded."
        )
      );

    return () => {
      pollingRef.current = false;
    };
  }, [initialBucket, user, visible]);

  /* ---------------- CUSTOM ESTIMATE ---------------- */

  useEffect(() => {
    if (
      !visible ||
      selected !== "custom" ||
      custom.paise === null ||
      custom.error ||
      !config.custom_topup_enabled
    ) {
      setCustomEstimate(null);
      setEstimateLoading(false);
      return;
    }

    let active = true;

    setEstimateLoading(true);

    const timer = setTimeout(
      () =>
        void getBillingEstimate(
          user,
          custom.paise!,
          bucket
        )
          .then((result) => {
            if (active) {
              setCustomEstimate(result);
            }
          })
          .catch(() => {
            if (active) {
              setError(
                "Token estimate is unavailable. Try again."
              );
            }
          })
          .finally(() => {
            if (active) {
              setEstimateLoading(false);
            }
          }),
      350
    );

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    bucket,
    config.custom_topup_enabled,
    custom.error,
    custom.paise,
    selected,
    user,
    visible,
  ]);

  /* ---------------- REFRESH ---------------- */

  const refreshAuthoritative = async () => {
    await refreshed();

    const result = await getPayments(user);

    setHistory(result.items);
  };

  /* ---------------- PENDING PAYMENT ---------------- */

  const finishPending = async (
    orderId: string,
    bucketForOrder: CreditBucket
  ) => {
    setPendingOrderId(orderId);

    setStatus(
      "Payment received. Waiting for secure confirmation…"
    );

    const deadline =
      Date.now() + 30000;

    while (
      pollingRef.current &&
      Date.now() < deadline
    ) {
      const payment =
        await getPaymentStatus(
          user,
          orderId
        ).catch(() => null);

      if (
        payment &&
        [
          "credited",
          "failed",
          "refunded",
          "partially_refunded",
        ].includes(payment.status)
      ) {
        await refreshAuthoritative().catch(
          () => undefined
        );

        if (
          payment.status === "credited"
        ) {
          setStatus(
            `${creditBucketLabel(
              bucketForOrder
            )} credits added.`
          );
        } else {
          setStatus(
            paymentStatusLabel(payment)
          );
        }

        setPendingOrderId(null);

        return;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, 2000)
      );
    }

    setStatus(
      "Confirmation is still pending. Your balance will update automatically after the payment webhook arrives."
    );
  };

  /* ---------------- CHECKOUT ---------------- */

  const checkout = async () => {
    if (
      busy ||
      offline ||
      !config.checkout_enabled ||
      amount === null ||
      !estimateReady
    ) {
      return;
    }

    setBusy(true);
    setError("");
    setStatus("Creating secure order…");

    const bucketForOrder = bucket;

    let order:
      | Awaited<
          ReturnType<typeof createBillingOrder>
        >
      | null = null;

    try {
      order =
        await createBillingOrder(user, {
          gross_amount_paise: amount,
          credit_bucket: bucketForOrder,
          idempotency_key:
            newSwicoRequestId(),
        });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Secure order creation failed. No payment was taken."
      );

      setStatus("");
      setBusy(false);

      return;
    }

    try {
      setStatus(
        "Opening secure payment checkout…"
      );

      const result =
        await RazorpayCheckout.open({
          key: order.key_id,
          amount: order.amount,
          currency: order.currency,
          order_id:
            order.provider_order_id,
          name: "Swico",
          description: `Prepaid ${creditBucketLabel(
            bucketForOrder
          )} credits`,
          notes: {
            internal_order_id:
              order.internal_order_id,
            credit_bucket:
              bucketForOrder,
          },
        });

      setStatus(
        "Confirming payment…"
      );

      try {
        const verified =
          await verifyBillingPayment(
            user,
            {
              internal_order_id:
                order.internal_order_id,
              ...result,
            }
          );

        if (verified.credited) {
          await refreshAuthoritative();

          setStatus(
            `${creditBucketLabel(
              bucketForOrder
            )} credits added.`
          );
        } else {
          await finishPending(
            order.internal_order_id,
            bucketForOrder
          );
        }
      } catch {
        await finishPending(
          order.internal_order_id,
          bucketForOrder
        );
      }
    } catch (caught) {
      const failure =
        caught &&
        typeof caught === "object"
          ? (caught as Record<
              string,
              unknown
            >)
          : {};

      const message =
        caught instanceof Error
          ? caught.message
          : String(
              failure.description ||
                failure.message ||
                caught ||
                ""
            );

      const cancelled =
        String(failure.code || "") ===
          "2" ||
        /cancelled by user|user cancelled|dismissed|back/i.test(
          message
        );

      if (cancelled) {
        setStatus(
          "Payment cancelled — no credits were added."
        );
      } else {
        setError(
          message ||
            "The payment provider could not complete checkout."
        );

        setStatus(
          "Payment provider reported a failure — no credits were added."
        );
      }
    } finally {
      setBusy(false);
    }
  };

  /* =====================================================
     UI
  ===================================================== */

  return (
    <Modal
      testID="swico-billing-modal"
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (!busy) close();
      }}
    >
      <View style={styles.overlay}>
        <View style={styles.modal}>

          {/* HEADER */}

          <View style={styles.header}>

            <View style={styles.headerLeft}>

              <View style={styles.logoBox}>
                <Ionicons
                  name="shield-checkmark"
                  size={24}
                  color="#2563EB"
                />
              </View>

              <View>
                <Text style={styles.title}>
                  Billing
                </Text>

                <Text style={styles.subtitle}>
                  Manage your credits and payments
                </Text>
              </View>

            </View>

            <Pressable
              testID="swico-billing-close"
              disabled={busy}
              onPress={close}
              style={styles.closeButton}
            >
              <Ionicons
                name="close"
                size={23}
                color="#2563EB"
              />
            </Pressable>

          </View>

          {/* MAIN TABS */}

          <View style={styles.mainTabs}>

            <Pressable
              onPress={() =>
                setTab("topup")
              }
              style={[
                styles.mainTab,
                tab === "topup" &&
                  styles.mainTabActive,
              ]}
            >
              <Ionicons
                name="card-outline"
                size={18}
                color={
                  tab === "topup"
                    ? "#FFFFFF"
                    : "#2563EB"
                }
              />

              <Text
                style={[
                  styles.mainTabText,
                  tab === "topup" &&
                    styles.mainTabTextActive,
                ]}
              >
                Pay as you go
              </Text>
            </Pressable>

            <Pressable
              onPress={() =>
                setTab("history")
              }
              style={[
                styles.mainTab,
                tab === "history" &&
                  styles.mainTabActive,
              ]}
            >
              <Ionicons
                name="time-outline"
                size={18}
                color={
                  tab === "history"
                    ? "#FFFFFF"
                    : "#2563EB"
                }
              />

              <Text
                style={[
                  styles.mainTabText,
                  tab === "history" &&
                    styles.mainTabTextActive,
                ]}
              >
                Payment history
              </Text>
            </Pressable>

          </View>

          {/* PAYMENT HISTORY */}

          {tab === "history" ? (

            <ScrollView
              style={styles.scroll}
              contentContainerStyle={
                styles.scrollContent
              }
              showsVerticalScrollIndicator={
                false
              }
            >

              <View
                style={styles.sectionHeader}
              >
                <Text
                  style={styles.sectionTitle}
                >
                  Payment history
                </Text>

                <Text
                  style={
                    styles.sectionDescription
                  }
                >
                  Your recent payments and refunds
                </Text>
              </View>

              {!history.length ? (

                <View
                  style={styles.emptyState}
                >
                  <View
                    style={styles.emptyIcon}
                  >
                    <Ionicons
                      name="receipt-outline"
                      size={28}
                      color="#2563EB"
                    />
                  </View>

                  <Text
                    style={styles.emptyTitle}
                  >
                    No payments yet
                  </Text>

                  <Text
                    style={styles.mutedCenter}
                  >
                    Your payment history will
                    appear here.
                  </Text>
                </View>

              ) : (

                history.map((item) => (

                  <View
                    key={item.id}
                    style={styles.historyCard}
                  >

                    <View
                      style={
                        styles.historyTop
                      }
                    >

                      <View
                        style={
                          styles.historyIcon
                        }
                      >
                        <Ionicons
                          name="receipt-outline"
                          size={19}
                          color="#2563EB"
                        />
                      </View>

                      <View
                        style={
                          styles.historyMain
                        }
                      >
                        <Text
                          style={
                            styles.cardTitle
                          }
                        >
                          {paymentStatusLabel(
                            item
                          )}
                        </Text>

                        <Text
                          style={
                            styles.muted
                          }
                        >
                          {creditBucketLabel(
                            item.credit_bucket ??
                              "chat"
                          )}{" "}
                          credits
                        </Text>
                      </View>

                      <Text
                        style={
                          styles.historyAmount
                        }
                      >
                        {formatRupeesFromPaise(
                          item.gross_amount_paise
                        )}
                      </Text>

                    </View>

                    <View
                      style={styles.divider}
                    />

                    <Text
                      style={styles.muted}
                    >
                      {new Date(
                        item.created_at
                      ).toLocaleDateString()}
                    </Text>

                    {item.token_estimate ? (
                      <Text
                        style={styles.muted}
                      >
                        Estimated tokens:{" "}
                        {tokenRangeLabel(
                          item.token_estimate
                        )}
                      </Text>
                    ) : null}

                    {item.voice_estimate ? (
                      <Text
                        style={styles.muted}
                      >
                        {voiceEstimateLabel(
                          item.voice_estimate
                        )}
                      </Text>
                    ) : null}

                  </View>

                ))

              )}

            </ScrollView>

          ) : (

            /* TOP UP */

            <ScrollView
              style={styles.scroll}
              contentContainerStyle={
                styles.scrollContent
              }
              showsVerticalScrollIndicator={
                false
              }
            >

              {/* CHAT / VOICE */}

              <View
                style={styles.creditTabs}
              >

                {/* CHAT CREDITS */}

                <Pressable
                  testID="swico-billing-chat"
                  onPress={() => {
                    setBucket("chat");
                    setCustomEstimate(null);
                  }}
                  style={[
                    styles.creditTab,
                    bucket === "chat" &&
                      styles.creditTabActive,
                  ]}
                >

                  <Ionicons
                    name="chatbubble-outline"
                    size={19}
                    color={
                      bucket === "chat"
                        ? "#FFFFFF"
                        : "#6B7280"
                    }
                  />

                  <Text
                    style={[
                      styles.creditTabText,
                      bucket === "chat" &&
                        styles.creditTabTextActive,
                    ]}
                  >
                    Chat credits
                  </Text>

                </Pressable>

                {/* VOICE CREDITS */}

                <Pressable
                  testID="swico-billing-voice"
                  onPress={() => {
                    setBucket("voice");
                    setCustomEstimate(null);
                  }}
                  style={[
                    styles.creditTab,
                    bucket === "voice" &&
                      styles.creditTabActive,
                  ]}
                >

                  <Ionicons
                    name="mic-outline"
                    size={19}
                    color={
                      bucket === "voice"
                        ? "#FFFFFF"
                        : "#2563EB"
                    }
                  />

                  <Text
                    style={[
                      styles.creditTabText,
                      bucket === "voice" &&
                        styles.creditTabTextActive,
                    ]}
                  >
                    Voice credits
                  </Text>

                </Pressable>

              </View>

              {/* SECTION */}

              <View
                style={styles.sectionHeader}
              >
                <Text
                  style={styles.sectionTitle}
                >
                  Choose an amount
                </Text>

                <Text
                  style={
                    styles.sectionDescription
                  }
                >
                  Select a credit package that
                  works for you
                </Text>
              </View>

              {/* PACKAGES */}

              <View style={styles.packages}>

                {config.packages.map(
                  (item, index) => {

                    const isSelected =
                      selected ===
                      item.gross_amount_paise;

                    return (
                      <Pressable
                        key={
                          item.gross_amount_paise
                        }
                        onPress={() =>
                          setSelected(
                            item.gross_amount_paise
                          )
                        }
                        style={[
                          styles.package,
                          isSelected &&
                            styles.packageSelected,
                        ]}
                      >

                        {index === 0 ? (

                          <View
                            style={styles.badge}
                          >
                            <Text
                              style={
                                styles.badgeText
                              }
                            >
                              POPULAR
                            </Text>
                          </View>

                        ) : index === 1 ? (

                          <View
                            style={[
                              styles.badge,
                              styles.bestBadge,
                            ]}
                          >
                            <Text
                              style={
                                styles.badgeText
                              }
                            >
                              BEST VALUE
                            </Text>
                          </View>

                        ) : null}

                        {isSelected ? (

                          <View
                            style={
                              styles.checkCircle
                            }
                          >
                            <Ionicons
                              name="checkmark"
                              size={14}
                              color="#FFFFFF"
                            />
                          </View>

                        ) : null}

                        <View
                          style={[
                            styles.packageIcon,
                            index === 1 &&
                              styles.packageIconGreen,
                            index === 2 &&
                              styles.packageIconBlue,
                          ]}
                        >

                          <Ionicons
                            name={
                              bucket === "chat"
                                ? "chatbubble-outline"
                                : "mic-outline"
                            }
                            size={24}
                            color="#2563EB"
                          />

                        </View>

                        <Text
                          style={
                            styles.packageTitle
                          }
                        >
                          Pay{" "}
                          {formatRupeesFromPaise(
                            item.gross_amount_paise
                          )}
                        </Text>

                        <Text
                          style={
                            styles.packageEstimate
                          }
                        >
                          {bucket === "chat"
                            ? tokenRangeLabel(
                                item.token_estimate
                              )
                            : voiceEstimateLabel(
                                item.voice_estimate
                              )}
                        </Text>

                        <Text
                          style={[
                            styles.packageHint,
                            index === 1 &&
                              styles.greenHint,
                          ]}
                        >
                          {index === 0
                            ? "Best for light usage"
                            : index === 1
                            ? "Best value"
                            : "More credits"}
                        </Text>

                      </Pressable>
                    );
                  }
                )}

                {/* CUSTOM */}

                {config.custom_topup_enabled ? (

                  <Pressable
                    onPress={() =>
                      setSelected("custom")
                    }
                    style={[
                      styles.package,
                      selected === "custom" &&
                        styles.packageSelected,
                    ]}
                  >

                    {selected ===
                    "custom" ? (

                      <View
                        style={
                          styles.checkCircle
                        }
                      >
                        <Ionicons
                          name="checkmark"
                          size={14}
                          color="#FFFFFF"
                        />
                      </View>

                    ) : null}

                    <View
                      style={[
                        styles.packageIcon,
                        styles.packageIconBlue,
                      ]}
                    >
                      <Ionicons
                        name="pencil-outline"
                        size={24}
                        color="#2563EB"
                      />
                    </View>

                    <Text
                      style={
                        styles.packageTitle
                      }
                    >
                      Custom amount
                    </Text>

                    <Text
                      style={
                        styles.packageEstimate
                      }
                    >
                      Enter whole rupees
                    </Text>

                    <Text
                      style={[
                        styles.packageHint,
                        styles.blueHint,
                      ]}
                    >
                      Flexible & custom
                    </Text>

                  </Pressable>

                ) : null}

              </View>

              {/* CUSTOM INPUT */}

              {selected === "custom" ? (

                <View
                  style={styles.customBox}
                >

                  <Text
                    style={styles.sectionTitle}
                  >
                    Custom amount
                  </Text>

                  <TextInput
                    value={customInput}
                    onChangeText={(value) => {
                      setCustomInput(value);
                      setCustomEstimate(null);
                    }}
                    keyboardType="number-pad"
                    placeholder="₹ Enter amount"
                    placeholderTextColor="#9CA3AF"
                    style={styles.input}
                  />

                  <Text
                    style={styles.muted}
                  >
                    Minimum{" "}
                    {formatRupeesFromPaise(
                      config.min_topup_paise
                    )}{" "}
                    · Maximum{" "}
                    {formatRupeesFromPaise(
                      config.max_topup_paise
                    )}
                  </Text>

                  {custom.error ? (
                    <Text
                      style={styles.error}
                    >
                      {custom.error}
                    </Text>
                  ) : null}

                  {estimateLoading ? (
                    <Text
                      style={styles.muted}
                    >
                      Calculating estimate…
                    </Text>
                  ) : null}

                </View>

              ) : null}

              {/* TOKEN USAGE */}

              {amount !== null &&
              estimateReady ? (

                <View
                  style={styles.usageCard}
                >

                  <View
                    style={
                      styles.usageHeader
                    }
                  >

                    <View
                      style={
                        styles.usageIcon
                      }
                    >
                      <Ionicons
                        name="pie-chart-outline"
                        size={25}
                        color="#2563EB"
                      />
                    </View>

                    <View
                      style={
                        styles.usageTextWrap
                      }
                    >
                      <Text
                        style={
                          styles.usageTitle
                        }
                      >
                        Your selected credits
                      </Text>

                      <Text
                        style={styles.muted}
                      >
                        {creditBucketLabel(
                          bucket
                        )}{" "}
                        credits
                      </Text>
                    </View>

                    <Text
                      style={
                        styles.usageAmount
                      }
                    >
                      {formatRupeesFromPaise(
                        amount
                      )}
                    </Text>

                  </View>

                  <View
                    style={styles.progressTrack}
                  >
                    <View
                      style={[
                        styles.progressFill,
                        {
                          width: "42%",
                        },
                      ]}
                    />
                  </View>

                  <View
                    style={
                      styles.usageBottom
                    }
                  >

                    <Text
                      style={styles.muted}
                    >
                      Estimated usage
                    </Text>

                    <Text
                      style={
                        styles.usageEstimate
                      }
                    >
                      {bucket === "chat"
                        ? tokenRangeLabel(
                            estimate?.token_estimate
                          )
                        : voiceEstimateLabel(
                            estimate?.voice_estimate
                          )}
                    </Text>

                  </View>

                </View>

              ) : null}

              {/* WHAT YOU CAN DO */}

              {amount !== null &&
              estimateReady &&
              bucket === "chat" ? (

                <View
                  style={styles.capabilities}
                >

                  <Text
                    style={
                      styles.capabilitiesTitle
                    }
                  >
                    What you can do with your
                    tokens
                  </Text>

                  <View
                    style={
                      styles.capabilityRow
                    }
                  >

                    <View
                      style={
                        styles.capability
                      }
                    >

                      <View
                        style={
                          styles.capabilityIcon
                        }
                      >
                        <Ionicons
                          name="chatbubble-outline"
                          size={18}
                          color="#2563EB"
                        />
                      </View>

                      <View>
                        <Text
                          style={
                            styles.capabilityTitle
                          }
                        >
                          Text messages
                        </Text>

                        <Text
                          style={
                            styles.capabilityText
                          }
                        >
                          ~1.8K – 10.8K
                        </Text>
                      </View>

                    </View>

                    <View
                      style={
                        styles.capability
                      }
                    >

                      <View
                        style={
                          styles.capabilityIcon
                        }
                      >
                        <Ionicons
                          name="document-outline"
                          size={18}
                          color="#2563EB"
                        />
                      </View>

                      <View>
                        <Text
                          style={
                            styles.capabilityTitle
                          }
                        >
                          Documents
                        </Text>

                        <Text
                          style={
                            styles.capabilityText
                          }
                        >
                          ~45 – 270 pages
                        </Text>
                      </View>

                    </View>

                    <View
                      style={
                        styles.capability
                      }
                    >

                      <View
                        style={
                          styles.capabilityIcon
                        }
                      >
                        <Ionicons
                          name="image-outline"
                          size={18}
                          color="#2563EB"
                        />
                      </View>

                      <View>
                        <Text
                          style={
                            styles.capabilityTitle
                          }
                        >
                          Images
                        </Text>

                        <Text
                          style={
                            styles.capabilityText
                          }
                        >
                          ~360 – 2.2K
                        </Text>
                      </View>

                    </View>

                    <View
                      style={
                        styles.capability
                      }
                    >

                      <View
                        style={
                          styles.capabilityIcon
                        }
                      >
                        <Ionicons
                          name="code-slash-outline"
                          size={18}
                          color="#2563EB"
                        />
                      </View>

                      <View>
                        <Text
                          style={
                            styles.capabilityTitle
                          }
                        >
                          Code & more
                        </Text>

                        <Text
                          style={
                            styles.capabilityText
                          }
                        >
                          ~9.5K lines
                        </Text>
                      </View>

                    </View>

                  </View>

                </View>

              ) : null}

              {/* CHECKOUT INFO */}

              {!config.checkout_enabled ? (

                <View
                  style={styles.infoBox}
                >

                  <Ionicons
                    name="information-circle-outline"
                    size={20}
                    color="#2563EB"
                  />

                  <Text
                    style={styles.muted}
                  >
                    Checkout is currently
                    disabled. Existing credits
                    can still be used.
                  </Text>

                </View>

              ) : null}

              {offline ? (

                <View
                  style={styles.errorBox}
                >

                  <Ionicons
                    name="cloud-offline-outline"
                    size={20}
                    color="#DC2626"
                  />

                  <Text
                    style={styles.error}
                  >
                    You are offline. Reconnect
                    before starting a secure
                    payment.
                  </Text>

                </View>

              ) : null}

              {pendingOrderId ? (

                <Text
                  style={styles.muted}
                >
                  Confirmation reference:{" "}
                  {pendingOrderId}
                </Text>

              ) : null}

              {/* PAYMENT BAR */}

              <View
                style={styles.payBar}
              >

                <View
                  style={styles.payLeft}
                >

                  <View
                    style={styles.payShield}
                  >
                    <Ionicons
                      name="shield-checkmark"
                      size={23}
                      color="#FFFFFF"
                    />
                  </View>

                  <View>
                    <Text
                      style={
                        styles.totalLabel
                      }
                    >
                      Total to pay
                    </Text>

                    <View
                      style={
                        styles.totalRow
                      }
                    >

                      <Text
                        style={
                          styles.totalAmount
                        }
                      >
                        {amount === null
                          ? "—"
                          : formatRupeesFromPaise(
                              amount
                            )}
                      </Text>

                      <Text
                        style={
                          styles.creditType
                        }
                      >
                        ({creditBucketLabel(
                          bucket
                        )} credits)
                      </Text>

                    </View>

                  </View>

                </View>

                <View
                  style={
                    styles.securePayment
                  }
                >

                  <Ionicons
                    name="lock-closed-outline"
                    size={15}
                    color="#FFFFFF"
                  />

                  <Text
                    style={
                      styles.securePaymentText
                    }
                  >
                    Secure payment
                  </Text>

                </View>

                <Pressable
                  disabled={
                    busy ||
                    offline ||
                    amount === null ||
                    !estimateReady ||
                    !config.checkout_enabled
                  }
                  onPress={() =>
                    void checkout()
                  }
                  style={[
                    styles.payButton,
                    (busy ||
                      offline ||
                      amount === null ||
                      !estimateReady ||
                      !config.checkout_enabled) &&
                      styles.disabled,
                  ]}
                >

                  {busy ? (

                    <ActivityIndicator
                      color="#FFFFFF"
                    />

                  ) : (

                    <>
                      <Text
                        style={
                          styles.payButtonText
                        }
                      >
                        {amount === null
                          ? "Choose amount"
                          : `Pay ${formatRupeesFromPaise(
                              amount
                            )} for ${creditBucketLabel(
                              bucket
                            )} credits`}
                      </Text>

                      <Ionicons
                        name="arrow-forward"
                        size={18}
                        color="#FFFFFF"
                      />
                    </>

                  )}

                </Pressable>

              </View>

              {/* TRUST FEATURES */}

              <View
                style={styles.trustRow}
              >

                <View
                  style={styles.trustItem}
                >

                  <View
                    style={[
                      styles.trustIcon,
                      styles.trustGreen,
                    ]}
                  >
                    <Ionicons
                      name="shield-checkmark-outline"
                      size={18}
                      color="#2563EB"
                    />
                  </View>

                  <View>
                    <Text
                      style={
                        styles.trustTitle
                      }
                    >
                      Secure payments
                    </Text>

                    <Text
                      style={
                        styles.trustText
                      }
                    >
                      Safe & encrypted
                    </Text>
                  </View>

                </View>

                <View
                  style={styles.trustItem}
                >

                  <View
                    style={styles.trustIcon}
                  >
                    <Ionicons
                      name="flash-outline"
                      size={18}
                      color="#2563EB"
                    />
                  </View>

                  <View>
                    <Text
                      style={
                        styles.trustTitle
                      }
                    >
                      Instant credit
                    </Text>

                    <Text
                      style={
                        styles.trustText
                      }
                    >
                      Added after payment
                    </Text>
                  </View>

                </View>

                <View
                  style={styles.trustItem}
                >

                  <View
                    style={styles.trustIcon}
                  >
                    <Ionicons
                      name="infinite-outline"
                      size={18}
                      color="#2563EB"
                    />
                  </View>

                  <View>
                    <Text
                      style={
                        styles.trustTitle
                      }
                    >
                      No expiry
                    </Text>

                    <Text
                      style={
                        styles.trustText
                      }
                    >
                      Credits don't expire
                    </Text>
                  </View>

                </View>

                <View
                  style={styles.trustItem}
                >

                  <View
                    style={[
                      styles.trustIcon,
                      styles.trustPink,
                    ]}
                  >
                    <Ionicons
                      name="headset-outline"
                      size={18}
                      color="#2563EB"
                    />
                  </View>

                  <View>
                    <Text
                      style={
                        styles.trustTitle
                      }
                    >
                      24/7 support
                    </Text>

                    <Text
                      style={
                        styles.trustText
                      }
                    >
                      We're here to help
                    </Text>
                  </View>

                </View>

              </View>

              {/* STATUS */}

              {status ? (

                <Text
                  style={styles.status}
                >
                  {status}
                </Text>

              ) : null}

              {error ? (

                <Text
                  style={styles.error}
                >
                  {error}
                </Text>

              ) : null}

            </ScrollView>

          )}

        </View>
      </View>
    </Modal>
  );
}

/* =========================================================
   STYLES
   ONLY CHAT CREDITS ACTIVE STATE CHANGED
========================================================= */

function createStyles() {
  return StyleSheet.create({

    overlay: {
      flex: 1,
      backgroundColor:
        "rgba(15, 23, 42, 0.55)",
      alignItems: "center",
      justifyContent: "center",
      padding: 20,
    },

    modal: {
      width: "100%",
      maxWidth: 1120,
      maxHeight: "94%",
      backgroundColor: "#FFFFFF",
      borderRadius: 24,
      overflow: "hidden",
      shadowColor: "#000000",
      shadowOpacity: 0.18,
      shadowRadius: 30,
      shadowOffset: {
        width: 0,
        height: 15,
      },
      elevation: 12,
    },

    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 24,
      paddingTop: 22,
      paddingBottom: 18,
    },

    headerLeft: {
      flexDirection: "row",
      alignItems: "center",
      gap: 13,
      flex: 1,
    },

    logoBox: {
      width: 46,
      height: 46,
      borderRadius: 14,
      backgroundColor: "#EAF2FF",
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: "#D5E5FF",
    },

    title: {
      color: "#2563EB",
      fontSize: 24,
      fontWeight: "900",
      letterSpacing: -0.5,
    },

    subtitle: {
      color: "#2563EB",
      fontSize: 12,
      marginTop: 3,
    },

    closeButton: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: "#EAF2FF",
      alignItems: "center",
      justifyContent: "center",
    },

    mainTabs: {
      flexDirection: "row",
      marginHorizontal: 22,
      padding: 4,
      borderRadius: 13,
      backgroundColor: "#EAF2FF",
      borderWidth: 1,
      borderColor: "#D5E5FF",
    },

    mainTab: {
      flex: 1,
      minHeight: 46,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "row",
      gap: 7,
    },

    mainTabActive: {
      backgroundColor: "#2563EB",
      borderWidth: 1,
      borderColor: "#2563EB",
      shadowColor: "#2563EB",
      shadowOpacity: 0.08,
      shadowRadius: 5,
      shadowOffset: {
        width: 0,
        height: 2,
      },
    },

    mainTabText: {
      color: "#2563EB",
      fontSize: 12,
      fontWeight: "800",
    },

    mainTabTextActive: {
      color: "#FFFFFF",
      fontWeight: "900",
    },

    scroll: {
      flexGrow: 0,
    },

    scrollContent: {
      paddingHorizontal: 22,
      paddingTop: 18,
      paddingBottom: 25,
      gap: 14,
    },

    sectionHeader: {
      gap: 3,
      marginTop: 2,
    },

    sectionTitle: {
      color: "#2563EB",
      fontSize: 17,
      fontWeight: "900",
    },

    sectionDescription: {
      color: "#2563EB",
      fontSize: 12,
      lineHeight: 18,
    },

    /* =========================
       CHAT / VOICE
       CHAT ACTIVE = BLUE
    ========================= */

    creditTabs: {
      flexDirection: "row",
      padding: 4,
      borderRadius: 13,
      backgroundColor: "#EAF2FF",
      borderWidth: 1,
      borderColor: "#D5E5FF",
    },

    creditTab: {
      flex: 1,
      minHeight: 44,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "row",
      gap: 8,
    },

    creditTabActive: {
  backgroundColor: "#2563EB",
  borderRadius: 10,
  borderWidth: 0,
  shadowColor: "#2563EB",
  shadowOpacity: 0.3,
  shadowRadius: 8,
  shadowOffset: {
    width: 0,
    height: 3,
  },
  elevation: 5,
},

    creditTabText: {
      color: "#2563EB",
      fontSize: 13,
      fontWeight: "800",
    },

    creditTabTextActive: {
  color: "#FFFFFF",
  fontSize: 13,
  fontWeight: "900",
},

    packages: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 12,
    },

    package: {
      flexGrow: 1,
      flexBasis: 230,
      minWidth: 190,
      minHeight: 188,
      padding: 15,
      borderRadius: 17,
      borderWidth: 1,
      borderColor: "#BFDBFE",
      backgroundColor: "#FFFFFF",
      position: "relative",
      overflow: "hidden",
    },

    packageSelected: {
      borderColor: "#2563EB",
      borderWidth: 2,
      backgroundColor: "#F5F9FF",
      shadowColor: "#2563EB",
      shadowOpacity: 0.12,
      shadowRadius: 10,
      shadowOffset: {
        width: 0,
        height: 3,
      },
      elevation: 3,
    },

    badge: {
      alignSelf: "flex-start",
      backgroundColor: "#2563EB",
      paddingHorizontal: 9,
      paddingVertical: 4,
      borderRadius: 20,
      marginBottom: 10,
    },

    bestBadge: {
      backgroundColor: "#2563EB",
    },

    badgeText: {
      color: "#FFFFFF",
      fontSize: 8,
      fontWeight: "900",
      letterSpacing: 0.4,
    },

    checkCircle: {
      position: "absolute",
      top: 12,
      right: 12,
      width: 24,
      height: 24,
      borderRadius: 13,
      backgroundColor: "#2563EB",
      alignItems: "center",
      justifyContent: "center",
    },

    packageIcon: {
      width: 47,
      height: 47,
      borderRadius: 14,
      backgroundColor: "#EAF2FF",
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 11,
    },

    packageIconGreen: {
      backgroundColor: "#EAF2FF",
    },

    packageIconBlue: {
      backgroundColor: "#EAF2FF",
    },

    packageTitle: {
      color: "#2563EB",
      fontSize: 17,
      fontWeight: "900",
      marginBottom: 5,
    },

    packageEstimate: {
      color: "#2563EB",
      fontSize: 11,
      lineHeight: 17,
      minHeight: 32,
    },

    packageHint: {
      color: "#2563EB",
      fontSize: 10,
      fontWeight: "800",
      marginTop: 8,
    },

    greenHint: {
      color: "#2563EB",
    },

    blueHint: {
      color: "#2563EB",
    },

    customBox: {
      backgroundColor: "#EAF2FF",
      borderWidth: 1,
      borderColor: "#BFDBFE",
      padding: 15,
      borderRadius: 16,
      gap: 8,
    },

    input: {
      color: "#2563EB",
      backgroundColor: "#FFFFFF",
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 13,
      borderWidth: 1,
      borderColor: "#2563EB",
      fontSize: 15,
      fontWeight: "700",
    },

    usageCard: {
      backgroundColor: "#EFF6FF",
      borderWidth: 1,
      borderColor: "#BFDBFE",
      borderRadius: 17,
      padding: 16,
      gap: 12,
    },

    usageHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 11,
    },

    usageIcon: {
      width: 45,
      height: 45,
      borderRadius: 14,
      backgroundColor: "#FFFFFF",
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: "#D7E7FF",
    },

    usageTextWrap: {
      flex: 1,
    },

    usageTitle: {
      color: "#2563EB",
      fontSize: 13,
      fontWeight: "900",
    },

    usageAmount: {
      color: "#2563EB",
      fontSize: 18,
      fontWeight: "900",
    },

    progressTrack: {
      height: 9,
      backgroundColor: "#D5E6FF",
      borderRadius: 10,
      overflow: "hidden",
    },

    progressFill: {
      height: "100%",
      backgroundColor: "#2563EB",
      borderRadius: 10,
    },

    usageBottom: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 10,
    },

    usageEstimate: {
      color: "#2563EB",
      fontSize: 11,
      fontWeight: "800",
      textAlign: "right",
    },

    capabilities: {
      borderWidth: 1,
      borderColor: "#DCE3EC",
      borderRadius: 17,
      padding: 15,
      backgroundColor: "#FFFFFF",
      gap: 13,
    },

    capabilitiesTitle: {
      color: "#2563EB",
      fontSize: 13,
      fontWeight: "900",
    },

    capabilityRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 12,
    },

    capability: {
      flexGrow: 1,
      flexBasis: 180,
      flexDirection: "row",
      alignItems: "center",
      gap: 9,
    },

    capabilityIcon: {
      width: 36,
      height: 36,
      borderRadius: 11,
      backgroundColor: "#EFF6FF",
      alignItems: "center",
      justifyContent: "center",
    },

    capabilityTitle: {
      color: "#2563EB",
      fontSize: 10,
      fontWeight: "800",
    },

    capabilityText: {
      color: "#2563EB",
      fontSize: 9,
      marginTop: 2,
    },

    infoBox: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: "#EFF6FF",
      padding: 12,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: "#BFDBFE",
    },

    errorBox: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: "#FEF2F2",
      padding: 12,
      borderRadius: 12,
    },

    payBar: {
      backgroundColor: "#2563EB",
      borderRadius: 18,
      padding: 11,
      paddingLeft: 13,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      marginTop: 3,
      shadowColor: "#2563EB",
      shadowOpacity: 0.18,
      shadowRadius: 12,
      shadowOffset: {
        width: 0,
        height: 4,
      },
      elevation: 4,
    },

    payLeft: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      minWidth: 170,
    },

    payShield: {
      width: 43,
      height: 43,
      borderRadius: 13,
      backgroundColor: "#2563EB",
      alignItems: "center",
      justifyContent: "center",
    },

    totalLabel: {
      color: "#FFFFFF",
      opacity: 0.7,
      fontSize: 9,
      fontWeight: "700",
    },

    totalRow: {
      flexDirection: "row",
      alignItems: "baseline",
      gap: 5,
    },

    totalAmount: {
      color: "#FFFFFF",
      fontSize: 20,
      fontWeight: "900",
      marginTop: 1,
    },

    creditType: {
      color: "#FFFFFF",
      opacity: 0.7,
      fontSize: 9,
    },

    securePayment: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 5,
    },

    securePaymentText: {
      color: "#FFFFFF",
      opacity: 0.75,
      fontSize: 9,
      fontWeight: "700",
    },

    payButton: {
      minHeight: 46,
      borderRadius: 12,
      backgroundColor: "#2563EB",
      paddingHorizontal: 15,
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "row",
      gap: 7,
      minWidth: 175,
    },

    payButtonText: {
      color: "#FFFFFF",
      fontWeight: "900",
      fontSize: 12,
    },

    disabled: {
      opacity: 0.45,
    },

    trustRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "space-between",
      gap: 10,
      paddingTop: 2,
    },

    trustItem: {
      flexGrow: 1,
      flexBasis: 190,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },

    trustIcon: {
      width: 34,
      height: 34,
      borderRadius: 10,
      backgroundColor: "#EAF2FF",
      alignItems: "center",
      justifyContent: "center",
    },

    trustGreen: {
      backgroundColor: "#EAF2FF",
    },

    trustPink: {
      backgroundColor: "#EAF2FF",
    },

    trustTitle: {
      color: "#2563EB",
      fontSize: 10,
      fontWeight: "800",
    },

    trustText: {
      color: "#2563EB",
      fontSize: 9,
      marginTop: 2,
    },

    divider: {
      height: 1,
      backgroundColor: "#BFDBFE",
      marginVertical: 3,
    },

    muted: {
      color: "#2563EB",
      fontSize: 11,
      lineHeight: 17,
    },

    mutedCenter: {
      color: "#2563EB",
      fontSize: 12,
      lineHeight: 18,
      textAlign: "center",
    },

    status: {
      color: "#2563EB",
      textAlign: "center",
      lineHeight: 19,
      fontSize: 12,
      fontWeight: "700",
    },

    error: {
      color: "#DC2626",
      lineHeight: 18,
      fontSize: 12,
    },

    emptyState: {
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 50,
      gap: 8,
    },

    emptyIcon: {
      width: 60,
      height: 60,
      borderRadius: 18,
      backgroundColor: "#EAF2FF",
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 5,
    },

    emptyTitle: {
      color: "#2563EB",
      fontSize: 16,
      fontWeight: "900",
    },

    historyCard: {
      borderWidth: 1,
      borderColor: "#DCE3EC",
      borderRadius: 16,
      padding: 14,
      backgroundColor: "#FFFFFF",
      gap: 6,
    },

    historyTop: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },

    historyIcon: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: "#EAF2FF",
      alignItems: "center",
      justifyContent: "center",
    },

    historyMain: {
      flex: 1,
      gap: 2,
    },

    cardTitle: {
      color: "#2563EB",
      fontWeight: "900",
      fontSize: 13,
    },

    historyAmount: {
      color: "#2563EB",
      fontWeight: "900",
      fontSize: 15,
    },
  });
}

