import { Box, Text } from "ink";
import { theme } from "../theme";

function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <Text>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
          <Text key={i} bold>
            {p.slice(2, -2)}
          </Text>
        ) : p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
          <Text key={i} color={theme.accentHover}>
            {p.slice(1, -1)}
          </Text>
        ) : (
          <Text key={i}>{p}</Text>
        ),
      )}
    </Text>
  );
}

export function Markdown({ text }: { text: string }) {
  const blocks: Array<{ code: boolean; lines: string[] }> = [];
  let cur: { code: boolean; lines: string[] } = { code: false, lines: [] };
  for (const line of text.replace(/\r/g, "").split("\n")) {
    if (line.trimStart().startsWith("```")) {
      blocks.push(cur);
      cur = { code: !cur.code, lines: [] };
      continue;
    }
    cur.lines.push(line);
  }
  blocks.push(cur);

  return (
    <Box flexDirection="column">
      {blocks
        .filter((b) => b.lines.length)
        .map((b, bi) =>
          b.code ? (
            <Box key={bi} borderStyle="single" borderColor={theme.muted} borderLeft borderRight={false} borderTop={false} borderBottom={false} paddingLeft={1}>
              <Text color={theme.secondary}>{b.lines.join("\n")}</Text>
            </Box>
          ) : (
            <Box key={bi} flexDirection="column">
              {b.lines.map((line, li) => {
                const h = line.match(/^#{1,6}\s+(.*)$/);
                if (h)
                  return (
                    <Text key={li} bold color={theme.accentHover}>
                      {h[1]}
                    </Text>
                  );
                const li_ = line.match(/^(\s*)[-*]\s+(.*)$/);
                if (li_)
                  return (
                    <Text key={li}>
                      {li_[1]}
                      <Text color={theme.accent}>• </Text>
                      <Inline text={li_[2]!} />
                    </Text>
                  );
                return <Inline key={li} text={line} />;
              })}
            </Box>
          ),
        )}
    </Box>
  );
}
