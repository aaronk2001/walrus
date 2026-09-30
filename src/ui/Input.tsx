import { Box, Text, useInput, type Key } from "ink";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { store, submit } from "../store";
import { suggest, type Suggestion } from "../commands";
import { listFiles, matchFiles, mentionAt } from "../attachments";
import { theme } from "../theme";
import { clip } from "../catalog";
import { useRefState } from "./useRefState";

export interface Edit {
  value: string;
  cursor: number;
}

const insert = (s: Edit, text: string): Edit => ({
  value: s.value.slice(0, s.cursor) + text + s.value.slice(s.cursor),
  cursor: s.cursor + text.length,
});

// Pure line-editing: returns the new state, or null if the key is not an edit.
export function applyEdit(s: Edit, input: string, key: Key, multiline = false): Edit | null {
  const { value, cursor } = s;
  if (key.leftArrow) return { value, cursor: Math.max(0, cursor - 1) };
  if (key.rightArrow) return { value, cursor: Math.min(value.length, cursor + 1) };
  if (key.home || (key.ctrl && input === "a")) return { value, cursor: value.lastIndexOf("\n", cursor - 1) + 1 };
  if (key.end || (key.ctrl && input === "e")) {
    const nl = value.indexOf("\n", cursor);
    return { value, cursor: nl === -1 ? value.length : nl };
  }
  if (key.ctrl && input === "u") return { value: value.slice(cursor), cursor: 0 };
  if (key.ctrl && input === "k") return { value: value.slice(0, cursor), cursor };
  if (key.ctrl && input === "w") {
    const left = value.slice(0, cursor).replace(/\S+\s*$/, "");
    return { value: left + value.slice(cursor), cursor: left.length };
  }
  // Windows terminals report Backspace as `delete`; treat both as backspace.
  if (key.backspace || key.delete) {
    if (!cursor) return s;
    return { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 };
  }
  // ctrl+j arrives as a bare linefeed
  if (input === "\n") return multiline ? insert(s, "\n") : null;
  if (key.ctrl || key.meta || key.escape || key.tab || key.return || key.upArrow || key.downArrow) return null;
  if (!input) return null;
  const text = input.replace(/\r\n?/g, "\n");
  return insert(s, multiline ? text : text.replace(/\n/g, " "));
}

function suggestionsFor(edit: Edit, files: string[]): { items: Suggestion[]; mention: ReturnType<typeof mentionAt> } {
  const mention = mentionAt(edit.value, edit.cursor);
  if (mention)
    return {
      mention,
      items: matchFiles(files, mention.query).map((f): Suggestion => ({ name: f, hint: "", kind: "file" })),
    };
  const { skills, commands } = store.getState();
  return { mention: null, items: suggest(edit.value, skills, commands) };
}

export function Input() {
  const running = useStore(store, (s) => s.running);
  const draft = store.getState().draft;
  const [getEdit, setEdit] = useRefState<Edit>({ value: draft, cursor: draft.length });
  useEffect(() => () => store.setState({ draft: getEdit().value }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [getHist, setHistIdx] = useRefState<number | null>(null);
  const [getSel, setSel] = useRefState(0);
  const cwd = useStore(store, (s) => s.cwd);
  useStore(store, (s) => s.skills);
  useStore(store, (s) => s.commands);
  const [files, setFiles] = useState<string[]>([]);
  const filesRef = useRef(files);
  filesRef.current = files;
  const edit = getEdit();
  const sel = getSel();
  const { items: suggestions, mention } = suggestionsFor(edit, files);
  useEffect(() => {
    if (mention && !files.length) void listFiles(cwd).then(setFiles);
  }, [mention !== null, cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  const setValue = (value: string) => setEdit({ value, cursor: value.length });

  const completed = (s: Suggestion, cur: Edit, m: typeof mention): Edit => {
    if (s.kind === "file" && m) {
      const before = cur.value.slice(0, m.start) + `@${s.name} `;
      return { value: before + cur.value.slice(cur.cursor), cursor: before.length };
    }
    return { value: `/${s.name} `, cursor: s.name.length + 2 };
  };
  const complete = (s: Suggestion, cur: Edit, m: typeof mention) => {
    setEdit(completed(s, cur, m));
    setSel(0);
  };

  useInput((input, key) => {
    const cur = getEdit();
    const { items: sug, mention: m } = suggestionsFor(cur, filesRef.current);
    const pick = () => sug[Math.min(getSel(), sug.length - 1)]!;
    if (key.tab && !key.shift && sug.length) return complete(pick(), cur, m);
    // fast typing can deliver tab and the next keys as one chunk
    if (!key.tab && input.length > 1 && input.startsWith("\t")) {
      const after = sug.length ? completed(pick(), cur, m) : cur;
      setEdit(applyEdit(after, input.slice(1), key, true) ?? after);
      setSel(0);
      return;
    }
    if (key.return) {
      if (m && sug.length) return complete(pick(), cur, m);
      // backslash + enter continues on a new line
      if (cur.value.slice(0, cur.cursor).endsWith("\\")) {
        setEdit({ value: cur.value.slice(0, cur.cursor - 1) + "\n" + cur.value.slice(cur.cursor), cursor: cur.cursor });
        return;
      }
      if (store.getState().running) return;
      let v = cur.value;
      if (sug.length && !v.includes(" ")) v = `/${pick().name}`;
      setValue("");
      setHistIdx(null);
      setSel(0);
      void submit(v);
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (sug.length > 1) {
        setSel((n) => (n + (key.upArrow ? sug.length - 1 : 1)) % sug.length);
        return;
      }
      // inside a multi-line draft, arrows move between lines
      if (cur.value.includes("\n")) {
        const lineStart = cur.value.lastIndexOf("\n", cur.cursor - 1) + 1;
        const col = cur.cursor - lineStart;
        if (key.upArrow && lineStart > 0) {
          const prevStart = cur.value.lastIndexOf("\n", lineStart - 2) + 1;
          return setEdit({ value: cur.value, cursor: Math.min(prevStart + col, lineStart - 1) });
        }
        const nextNl = cur.value.indexOf("\n", cur.cursor);
        if (key.downArrow && nextNl !== -1) {
          const nextEnd = cur.value.indexOf("\n", nextNl + 1);
          return setEdit({ value: cur.value, cursor: Math.min(nextNl + 1 + col, nextEnd === -1 ? cur.value.length : nextEnd) });
        }
      }
      const hist = store.getState().inputHistory;
      if (!hist.length) return;
      const last = hist.length - 1;
      const h = getHist();
      const next = key.upArrow ? (h === null ? last : Math.max(0, h - 1)) : h === null ? null : h + 1;
      if (next === null || next > last) {
        setHistIdx(null);
        setValue("");
      } else {
        setHistIdx(next);
        setValue(hist[next]!);
      }
      return;
    }
    const n = applyEdit(cur, input, key, true);
    if (n) {
      setEdit(n);
      setSel(0);
    }
  });

  const lines = (edit.value.slice(0, edit.cursor) + "\u0000" + edit.value.slice(edit.cursor)).split("\n");

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={running ? theme.muted : theme.accent} paddingX={1}>
        <Text color={theme.accent}>› </Text>
        {edit.value ? (
          <Box flexDirection="column">
            {lines.map((line, i) => {
              const at = line.indexOf("\u0000");
              if (at === -1) return <Text key={i}>{line || " "}</Text>;
              const rest = line.slice(at + 1);
              return (
                <Text key={i}>
                  {line.slice(0, at)}
                  <Text inverse>{rest[0] ?? " "}</Text>
                  {rest.slice(1)}
                </Text>
              );
            })}
          </Box>
        ) : (
          <Text>
            <Text inverse> </Text>
            <Text color={theme.muted}>
              {running ? "Walrus is working… (esc to interrupt)" : "Ask anything · / commands · @ files · ctrl+j newline"}
            </Text>
          </Text>
        )}
      </Box>
      {suggestions.length > 0 && (
        <Box flexDirection="column" paddingX={2}>
          {suggestions.map((s, i) => (
            <Text key={s.kind + s.name} color={i === sel ? theme.accentHover : theme.tertiary}>
              {i === sel ? "› " : "  "}
              {s.kind === "file" ? `@${s.name}` : `/${s.name.padEnd(22)}`}
              <Text color={theme.muted}>
                {s.kind === "skill" ? "skill · " : s.kind === "user" ? "command · " : ""}
                {clip(s.hint, 70)}
              </Text>
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
