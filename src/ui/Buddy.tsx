import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { renderPixels, tinyWalrus, type Mood } from "../mascot";

const CACHE = new Map<Mood, string[]>();
const art = (m: Mood) => {
  if (!CACHE.has(m)) CACHE.set(m, renderPixels(tinyWalrus(m)));
  return CACHE.get(m)!;
};

// Small live walrus: blinks while working, looks aside during tools, sleepy while waiting on Ollama.
export function Buddy({ state }: { state: "working" | "tool" | "waiting" }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 150);
    return () => clearInterval(t);
  }, []);
  const blinking = tick % 24 >= 22;
  const mood: Mood = state === "waiting" ? (blinking ? "blink" : "sleepy") : state === "tool" ? "look" : blinking ? "blink" : "idle";
  return (
    <Box flexDirection="column" marginRight={1}>
      {art(mood).map((l, i) => (
        <Text key={i}>{l}</Text>
      ))}
    </Box>
  );
}
