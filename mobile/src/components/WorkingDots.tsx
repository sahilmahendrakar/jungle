// Three small bouncing dots — the "agent is working" indicator inside running turn chips
// (matching the web's WorkingDots). Staggered translateY bounce via built-in Animated; one shared
// looped value with per-dot phase offsets (delays) so we don't spin up three timers.
import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { emerald } from "../theme";

export function WorkingDots({ color = emerald.base }: { color?: string }) {
  const dots = [useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current];

  useEffect(() => {
    const loops = dots.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 150),
          Animated.timing(v, { toValue: -3, duration: 250, useNativeDriver: true }),
          Animated.timing(v, { toValue: 0, duration: 250, useNativeDriver: true }),
          Animated.delay((2 - i) * 150),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.row}>
      {dots.map((v, i) => (
        <Animated.View
          key={i}
          style={[styles.dot, { backgroundColor: color, transform: [{ translateY: v }] }]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 3 },
  dot: { width: 5, height: 5, borderRadius: 2.5 },
});
