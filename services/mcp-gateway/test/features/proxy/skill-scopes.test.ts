import { readdirSync, readFileSync } from 'node:fs';
import { readListScope, readScope, readTier } from '@poc/mcp-kit';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { AUDIENCE_SCOPES, GATEWAY_AUDIENCE } from '../../../../../apps/bff/src/features/idp/client-policies.js';
import { createStack, GATEWAY_SECRET } from '../../support/stack.js';

// Frontmatter `scopes` repeats what each tool's `_meta` says. A mismatch hides a tool with no error, so this
// reads both from the real backends and the real skills (drift).
const SKILLS_DIR = new URL('../../../../bot/skills/', import.meta.url);

interface Skill {
  name: string;
  tools: string[];
  scopes: string[];
}
interface ServedTool {
  name: string;
  backend: string;
  tier: string | undefined;
  callScope: string | undefined;
  listScope: string | undefined;
}

function loadSkills(): Skill[] {
  return readdirSync(SKILLS_DIR)
    .filter((file) => file.endsWith('.md'))
    .map((file) => {
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(readFileSync(new URL(file, SKILLS_DIR), 'utf8'))?.[1] ?? '';
      const meta = parse(frontmatter) as { name: string; tools?: string[]; scopes?: string[] };
      return { name: meta.name, tools: meta.tools ?? [], scopes: meta.scopes ?? [] };
    });
}

async function servedTools(): Promise<ServedTool[]> {
  const stack = await createStack();
  const gatewayToken = await stack.gatewayToken('juan');
  const served: ServedTool[] = [];
  for (const [host, audience, backend] of [
    ['accounts.test', 'mcp-accounts', 'mcp-accounts'],
    ['payments.test', 'mcp-payments', 'mcp-payments'],
  ] as const) {
    const token = await stack.exchangeAs('mcp-gateway', GATEWAY_SECRET, gatewayToken, audience);
    const { tools } = await (await stack.connectBackend(host, token)).listTools();
    for (const tool of tools) {
      const meta = tool._meta as Record<string, unknown> | undefined;
      served.push({
        name: tool.name,
        backend,
        tier: readTier(meta),
        callScope: readScope(meta),
        listScope: readListScope(meta),
      });
    }
  }
  return served;
}

describe('skill scopes against the tools the real backends serve', () => {
  const skills = loadSkills();

  it('reads the skills it checks', () => {
    expect(skills.map((s) => s.name).sort()).toEqual(['accounts', 'knowledge', 'payments']);
  });

  it("lists every banking tool's list scope in each skill that allow-lists it", async () => {
    const served = new Map((await servedTools()).map((t) => [t.name, t]));
    for (const skill of skills) {
      for (const name of skill.tools) {
        const tool = served.get(name);
        if (!tool) continue; // bot-local, such as search_knowledge
        expect(skill.scopes, `${skill.name} allows ${name}`).toContain(tool.listScope);
      }
    }
  });

  it('declares only scopes that list at least one of the skill tools', async () => {
    const served = new Map((await servedTools()).map((t) => [t.name, t]));
    for (const skill of skills) {
      const listed = new Set(skill.tools.map((name) => served.get(name)?.listScope));
      for (const scope of skill.scopes) expect(listed, `${skill.name} requests ${scope}`).toContain(scope);
    }
  });

  it('never has a skill request the call scope of a T3 tool, which only an approved call gets', async () => {
    const t3CallScopes = (await servedTools()).filter((t) => t.tier === 'T3').map((t) => t.callScope);
    expect(t3CallScopes).toContain('transfers:execute');
    for (const skill of skills) {
      for (const scope of skill.scopes) expect(t3CallScopes, `${skill.name} requests ${scope}`).not.toContain(scope);
    }
  });

  it("sets each backend's IdP ceiling to the union of its tools' call scopes", async () => {
    const served = await servedTools();
    for (const backend of ['mcp-accounts', 'mcp-payments']) {
      const union = new Set(served.filter((t) => t.backend === backend).map((t) => t.callScope));
      expect(new Set(AUDIENCE_SCOPES[backend]), backend).toEqual(union);
    }
    expect(new Set(AUDIENCE_SCOPES[GATEWAY_AUDIENCE])).toEqual(new Set(served.map((t) => t.callScope)));
  });
});
