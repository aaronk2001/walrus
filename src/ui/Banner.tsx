import { Box, Text } from "ink";
import { homedir } from "node:os";
import { renderPixels, WALRUS } from "../mascot";
import { theme } from "../theme";
import { VERSION } from "../version";

const MASCOT = renderPixels(WALRUS);

export const tildify = (p: string) => {
  const home = homedir();
  return p.toLowerCase().startsWith(home.toLowerCase()) ? "~" + p.slice(home.length).replaceAll("\\", "/") : p;
};

export function Banner(props: { model: string; cwd: string; skills: number; agents: number; ollamaOk: boolean }) {
  return (
    <Box borderStyle="round" borderColor={theme.deep} paddingX={1} marginBottom={1} alignSelf="flex-start">
      <Box flexDirection="column" marginRight={2}>
        {MASCOT.map((l, i) => (
          <Text key={i}>{l}</Text>
        ))}
      </Box>
      <Box flexDirection="column" justifyContent="center">
        <Text>
          <Text bold color={theme.text}>
            Walrus
          </Text>
          <Text color={theme.tertiary}> v{VERSION}</Text>
        </Text>
        <Text>
          <Text color={theme.accent}>{props.model}</Text>
          <Text color={theme.tertiary}> · </Text>
          {props.ollamaOk ? <Text color={theme.tertiary}>Ollama</Text> : <Text color={theme.red}>Ollama offline</Text>}
        </Text>
        <Text color={theme.tertiary}>{tildify(props.cwd)}</Text>
        <Text color={theme.muted}>
          {props.skills} skills · {props.agents} agents
        </Text>
        <Text> </Text>
        <Text color={theme.muted}>
          <Text color={theme.secondary}>/help</Text> commands · <Text color={theme.secondary}>/hub</Text> models & skills
        </Text>
      </Box>
    </Box>
  );
}
