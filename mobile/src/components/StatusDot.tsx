// An agent status dot, mapping AgentStatus → color (frontend STATUS_DOT). `working`/`waking`
// pulse via a looped opacity Animated.Value (native driver). One value per mounted dot; cheap
// enough since a screen shows a handful, not hundreds.
import { useEffect, useRef } from "react";
import { Animated } from "react-native";
import type { AgentStatus } from "@jungle/shared";
import { status as STATUS } from "../theme";

export function StatusDot({ status, size = 6 }: { status?: AgentStatus | string | null; size?: number }) {
  const spec = (status && STATUS[status]) || null;
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!spec?.pulse) {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.35, duration: 750, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 750, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [spec?.pulse, opacity]);

  if (!spec) return null;
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: spec.color,
        opacity,
        ...(spec.ring ? { borderWidth: 1, borderColor: spec.ring } : null),
      }}
    />
  );
}
