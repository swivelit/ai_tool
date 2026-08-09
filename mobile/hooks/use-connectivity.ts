import { useEffect, useState } from "react";
import NetInfo from "@react-native-community/netinfo";

export function useConnectivity() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let mounted = true;
    void NetInfo.fetch().then(state => { if (mounted) setOffline(state.isConnected === false || state.isInternetReachable === false); });
    const unsubscribe = NetInfo.addEventListener(state => setOffline(state.isConnected === false || state.isInternetReachable === false));
    return () => { mounted = false; unsubscribe(); };
  }, []);
  return offline;
}

