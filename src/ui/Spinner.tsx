import { Text } from "ink";
import { useEffect, useState } from "react";
import { theme } from "../theme";

const FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const VERBS = ["Blubbering", "Flippering", "Tusking", "Hauling out", "Diving", "Basking", "Whiskering", "Clam-digging"];

export function Spinner({ label }: { label?: string }) {
  const [tick, setTick] = useState(0);
  const [start] = useState(() => Date.now());
  const [verb] = useState(() => VERBS[Math.floor(Math.random() * VERBS.length)]!);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 120);
    return () => clearInterval(t);
  }, []);
  const secs = Math.floor((Date.now() - start) / 1000);
  return (
    <Text>
      <Text color={theme.accent}>{FRAMES[tick % FRAMES.length]} </Text>
      <Text color={theme.accentHover}>{label ?? `${verb}…`}</Text>
      <Text color={theme.muted}>
        {" "}
        ({secs}s · esc to interrupt)
      </Text>
    </Text>
  );
}
