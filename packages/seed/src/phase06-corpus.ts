import type { PoolClient } from 'pg';
import { hashCanonical, stableUuid } from '../../domain/src/index.js';
import { querySignalPolicyV1 } from '../../scoring/src/index.js';
import { discoveryCorpusV1 } from './discovery-corpus.js';

const namespace = 'maestro-ai:phase06:corpus-v1';
const observedAt = '2026-09-29T12:00:00.000Z';

export interface CorpusRecord {
  key: string;
  name: string;
  kind: string;
  capabilityKey: string;
  capabilityName: string;
  summary: string;
  searchText: string;
  aliases: string[];
  sourceUrl: string;
  sourceTitle: string;
  sourceOwner: string;
  domainKey: string;
  additionalEvidence?: Array<{
    url: string;
    title: string;
    owner: string;
    summary: string;
    limitations: string[];
  }>;
}

// These records are deliberately proposed, not reviewed facts. They preserve
// the Phase 06 source-register identity and a narrow publisher/documentation
// observation so the cached explorer can show useful breadth without claiming
// a human audit or live integration test.
export const phase06CorpusV1: CorpusRecord[] = [
  {
    key: 'no-ai-slop',
    name: 'No AI Slop',
    kind: 'skill',
    capabilityKey: 'writing-quality-guidance',
    capabilityName: 'Writing quality guidance',
    summary: 'Editing guidance aimed at reducing generic AI-writing patterns.',
    searchText: 'ai writing language tone prose editing no slop copy quality guidance',
    aliases: ['no-ai-slop', 'AI writing style guidance'],
    sourceUrl: 'https://github.com/petergyang/no-ai-slop',
    sourceTitle: 'No AI Slop repository',
    sourceOwner: 'petergyang',
    domainKey: 'skills-plugins',
  },
  {
    key: 'frontend-design-skill',
    name: 'Frontend Design Skill',
    kind: 'skill',
    capabilityKey: 'interface-design-guidance',
    capabilityName: 'Interface design guidance',
    summary: 'A design-process skill for more intentional frontend visual work.',
    searchText: 'ai ui visual design frontend interface aesthetic no slop guidance',
    aliases: ['frontend-design', 'Anthropic frontend design'],
    sourceUrl:
      'https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md',
    sourceTitle: 'Anthropic frontend-design skill',
    sourceOwner: 'Anthropic',
    domainKey: 'skills-plugins',
  },
  {
    key: 'awesome-design-md',
    name: 'Awesome Design MD',
    kind: 'registry',
    capabilityKey: 'design-reference-discovery',
    capabilityName: 'Design reference discovery',
    summary: 'A curated collection of design references and reusable design context.',
    searchText: 'ai ui design reference screenshots visual inspiration markdown',
    aliases: ['awesome-design-md', 'design md'],
    sourceUrl: 'https://github.com/VoltAgent/awesome-design-md',
    sourceTitle: 'Awesome Design MD repository',
    sourceOwner: 'VoltAgent',
    domainKey: 'registries-discovery',
  },
  {
    key: 'searxng',
    name: 'SearXNG',
    kind: 'oss_project',
    capabilityKey: 'metasearch-discovery',
    capabilityName: 'Metasearch discovery',
    summary: 'A self-hostable metasearch engine with an operator-enabled JSON search API.',
    searchText: 'local ai search metasearch no api key external engines json discovery',
    aliases: ['SearXNG search API', 'self-hosted metasearch'],
    sourceUrl: 'https://docs.searxng.org/dev/search_api.html',
    sourceTitle: 'SearXNG Search API documentation',
    sourceOwner: 'SearXNG',
    domainKey: 'registries-discovery',
  },
  {
    key: 'ollama',
    name: 'Ollama',
    kind: 'runtime',
    capabilityKey: 'local-model-runtime',
    capabilityName: 'Local model runtime',
    summary: 'A local runtime and API for running explicitly provisioned model artifacts.',
    searchText: 'local ai inference model runtime offline api no cloud model weights',
    aliases: ['Ollama local models'],
    sourceUrl: 'https://docs.ollama.com/',
    sourceTitle: 'Ollama documentation',
    sourceOwner: 'Ollama',
    domainKey: 'capability-infrastructure',
  },
  {
    key: 'ai-sdk',
    name: 'AI SDK',
    kind: 'library',
    capabilityKey: 'model-provider-integration',
    capabilityName: 'Model provider integration',
    summary: 'A TypeScript toolkit for model calls, structured output, and provider adapters.',
    searchText: 'ai sdk typescript structured output model provider local compatible api',
    aliases: ['Vercel AI SDK'],
    sourceUrl: 'https://ai-sdk.dev/docs/introduction',
    sourceTitle: 'AI SDK introduction',
    sourceOwner: 'Vercel',
    domainKey: 'capability-infrastructure',
  },
  {
    key: 'model-context-protocol',
    name: 'Model Context Protocol',
    kind: 'protocol',
    capabilityKey: 'tool-context-interoperability',
    capabilityName: 'Tool and context interoperability',
    summary:
      'A protocol specification for connecting AI applications to tools and context sources.',
    searchText: 'ai mcp protocol tool context server interoperability specification',
    aliases: ['MCP', 'Model Context Protocol specification'],
    sourceUrl: 'https://modelcontextprotocol.io/specification/2025-06-18',
    sourceTitle: 'Model Context Protocol specification',
    sourceOwner: 'Model Context Protocol',
    domainKey: 'tool-agent-protocols',
  },
  {
    key: 'promptfoo',
    name: 'Promptfoo',
    kind: 'framework',
    capabilityKey: 'model-output-evaluation',
    capabilityName: 'Model output evaluation',
    summary: 'An evaluation framework for testing prompts, models, and AI application behavior.',
    searchText: 'ai prompt model evaluation testing red team quality benchmark',
    aliases: ['promptfoo evals'],
    sourceUrl: 'https://www.promptfoo.dev/docs/intro/',
    sourceTitle: 'Promptfoo introduction',
    sourceOwner: 'Promptfoo',
    domainKey: 'observability-evaluation',
  },
  {
    key: 'reticle',
    name: 'Reticle',
    kind: 'plugin',
    capabilityKey: 'runtime-agent-verification',
    capabilityName: 'Runtime agent verification',
    summary:
      'A dev-only runtime observation layer that exposes application state, network, console, routes, and DOM to coding agents.',
    searchText:
      'ai coding agent runtime verification web app browser ui observe observation mcp dom network console state proof testing playwright complement',
    aliases: ['reticlehq', 'Reticle proof layer'],
    sourceUrl: 'https://github.com/reticlehq/reticle',
    sourceTitle: 'Reticle repository',
    sourceOwner: 'Reticle',
    domainKey: 'agent-workflow-evaluation',
  },
  {
    key: 'chisle',
    name: 'Chisle',
    kind: 'plugin',
    capabilityKey: 'agent-context-efficiency-guidance',
    capabilityName: 'Agent context and implementation efficiency guidance',
    summary:
      'An agent plugin and ruleset for concise output, reuse-first implementation, and bounded tool-output compression.',
    searchText:
      'ai coding agent skill hooks context token output compression concise yagni reuse implementation efficiency codex',
    aliases: ['Chisle agent plugin', 'chisle ruleset'],
    sourceUrl: 'https://github.com/JayPokale/Chisle',
    sourceTitle: 'Chisle repository',
    sourceOwner: 'JayPokale',
    domainKey: 'skills-plugins',
  },
  {
    key: 'ponytail',
    name: 'Ponytail',
    kind: 'plugin',
    capabilityKey: 'minimal-change-guidance',
    capabilityName: 'Minimal-change engineering guidance',
    summary:
      'An agent-portable skill and ruleset that makes new code the last resort while retaining safety checks.',
    searchText:
      'ai coding agent skill hooks yagni reuse native platform smallest change overengineering codex',
    aliases: ['Ponytail coding skill', 'ponytail review'],
    sourceUrl: 'https://github.com/DietrichGebert/ponytail',
    sourceTitle: 'Ponytail repository',
    sourceOwner: 'DietrichGebert',
    domainKey: 'skills-plugins',
    additionalEvidence: [
      {
        url: 'https://blog.jetbrains.com/ai/2026/07/ponytail-skill-claude-tested/',
        title: 'Ponytail Skill for Claude Code: Does It Really Cut Tokens?',
        owner: 'JetBrains',
        summary:
          'An independent paired SkillsBench evaluation reported less generated code and lower cost under its tested Claude configuration, with no statistically significant quality difference.',
        limitations: [
          'The evaluation used Claude Code and an emulated plugin configuration, not Codex or this repository.',
          'A null quality difference does not establish equivalence or universal safety.',
        ],
      },
    ],
  },
  {
    key: 'gitnexus',
    name: 'GitNexus',
    kind: 'mcp_server',
    capabilityKey: 'repository-code-intelligence',
    capabilityName: 'Repository code intelligence',
    summary:
      'A local code knowledge graph and MCP surface for dependencies, call chains, impact analysis, and repository navigation.',
    searchText:
      'ai coding repository code intelligence graph mcp dependency call chain impact blast radius context navigation local',
    aliases: ['Git Nexus', 'GitNexus code graph'],
    sourceUrl: 'https://github.com/abhigyanpatwari/GitNexus',
    sourceTitle: 'GitNexus repository',
    sourceOwner: 'Abhigyan Patwari',
    domainKey: 'context-code-intelligence',
  },
  {
    key: 'superpowers',
    name: 'Superpowers',
    kind: 'plugin',
    capabilityKey: 'agent-development-methodology',
    capabilityName: 'Agent development methodology',
    summary:
      'A composable skill-based software-development methodology for coding agents, including planning, testing, review, and optional subagent workflows.',
    searchText:
      'ai coding agent skills methodology planning test driven development review worktree subagent orchestration codex',
    aliases: ['obra superpowers', 'Superpowers skills'],
    sourceUrl: 'https://github.com/obra/superpowers',
    sourceTitle: 'Superpowers repository',
    sourceOwner: 'Prime Radiant',
    domainKey: 'skills-plugins',
  },
  {
    key: 'composio',
    name: 'Composio',
    kind: 'platform',
    capabilityKey: 'agent-tool-integration-platform',
    capabilityName: 'Agent tool integration platform',
    summary:
      'An SDK and hosted tool platform for agent-facing app integrations, authentication, tool routing, triggers, and execution.',
    searchText:
      'ai agent tool integrations mcp authentication oauth actions execution external apps platform composio',
    aliases: ['Composio SDK', 'Composio toolkits'],
    sourceUrl: 'https://github.com/ComposioHQ/composio',
    sourceTitle: 'Composio repository',
    sourceOwner: 'Composio',
    domainKey: 'capability-infrastructure',
  },
  {
    key: 'codex-skills',
    name: 'Codex Skills',
    kind: 'practice',
    capabilityKey: 'repeatable-agent-workflows',
    capabilityName: 'Repeatable agent workflows',
    summary:
      'Focused, progressively disclosed instructions and resources for repeatable Codex workflows.',
    searchText:
      'ai coding agent codex skills repeatable workflow instructions progressive disclosure scripts references',
    aliases: ['Agent Skills', 'OpenAI Codex skills'],
    sourceUrl: 'https://developers.openai.com/plugins/concepts/skills',
    sourceTitle: 'OpenAI Skills documentation',
    sourceOwner: 'OpenAI',
    domainKey: 'skills-plugins',
  },
  {
    key: 'codex-hooks',
    name: 'Codex Hooks',
    kind: 'runtime',
    capabilityKey: 'agent-lifecycle-hooks',
    capabilityName: 'Agent lifecycle hooks',
    summary: 'Trusted commands or MCP checks that run at configured Codex lifecycle points.',
    searchText:
      'ai coding agent codex hooks lifecycle validation policy pretool posttool stop session automation scripts',
    aliases: ['OpenAI Codex hooks', 'lifecycle hooks'],
    sourceUrl: 'https://learn.chatgpt.com/docs/hooks',
    sourceTitle: 'OpenAI Codex Hooks documentation',
    sourceOwner: 'OpenAI',
    domainKey: 'agent-control-planes',
  },
  {
    key: 'codex-subagents',
    name: 'Codex Subagents',
    kind: 'agent',
    capabilityKey: 'bounded-agent-delegation',
    capabilityName: 'Bounded agent delegation',
    summary: 'A Codex capability for parallel, specialized subtasks coordinated by a parent agent.',
    searchText:
      'ai coding agent codex subagent parallel delegation orchestration specialist multi agent workflow',
    aliases: ['Codex multi-agent', 'OpenAI subagents'],
    sourceUrl: 'https://learn.chatgpt.com/docs/agent-configuration/subagents',
    sourceTitle: 'OpenAI Codex Subagents documentation',
    sourceOwner: 'OpenAI',
    domainKey: 'agent-control-planes',
  },
  {
    key: 'build-web-apps',
    name: 'Build Web Apps',
    kind: 'plugin',
    capabilityKey: 'agent-web-application-development',
    capabilityName: 'Agent-assisted web application development',
    summary:
      'A Codex workflow for creating or refining web applications and preparing a deployable preview.',
    searchText:
      'ai coding agent codex build web apps frontend ui design implementation deploy preview plugin',
    aliases: ['build-web-apps', 'Codex Build Web Apps'],
    sourceUrl: 'https://learn.chatgpt.com/use-cases/deploy-app-or-website',
    sourceTitle: 'OpenAI deploy an app or website use case',
    sourceOwner: 'OpenAI',
    domainKey: 'skills-plugins',
  },
  {
    key: 'openai-agents-sdk',
    name: 'OpenAI Agents SDK',
    kind: 'framework',
    capabilityKey: 'agent-runtime-orchestration',
    capabilityName: 'Agent runtime and orchestration',
    summary:
      'A TypeScript agent runtime with tools, handoffs, guardrails, sessions, tracing, and orchestration primitives.',
    searchText:
      'ai agent runtime orchestration multi agent models tools handoffs guardrails tracing typescript sdk',
    aliases: ['Agents SDK', '@openai/agents'],
    sourceUrl: 'https://github.com/openai/openai-agents-js',
    sourceTitle: 'OpenAI Agents SDK TypeScript repository',
    sourceOwner: 'OpenAI',
    domainKey: 'agent-control-planes',
  },
  {
    key: 'litellm-gateway',
    name: 'LiteLLM Gateway',
    kind: 'gateway',
    capabilityKey: 'multi-model-gateway',
    capabilityName: 'Multi-model gateway',
    summary:
      'An OpenAI-compatible gateway for configuring model providers, keys, budgets, routing, and usage records.',
    searchText:
      'ai multi model routing gateway proxy providers keys budget usage openai compatible litellm',
    aliases: ['LiteLLM Proxy', 'LiteLLM'],
    sourceUrl: 'https://github.com/BerriAI/litellm',
    sourceTitle: 'LiteLLM repository',
    sourceOwner: 'BerriAI',
    domainKey: 'capability-infrastructure',
  },
  {
    key: 'awesome-codex-plugins',
    name: 'Awesome Codex Plugins',
    kind: 'registry',
    capabilityKey: 'codex-ecosystem-discovery',
    capabilityName: 'Codex ecosystem discovery',
    summary:
      'A curated catalog of Codex plugins, skills, and related resources that can supply research leads.',
    searchText:
      'ai codex plugin skill registry awesome catalog discovery research leads ecosystem marketplace',
    aliases: ['Hashgraph Awesome Codex Plugins', 'Codex plugin catalog'],
    sourceUrl: 'https://github.com/hashgraph-online/awesome-codex-plugins',
    sourceTitle: 'Awesome Codex Plugins repository',
    sourceOwner: 'Hashgraph Online',
    domainKey: 'registries-discovery',
  },
  {
    key: 'command-compressor-agent',
    name: 'Command Compressor Agent',
    kind: 'plugin',
    capabilityKey: 'reversible-tool-output-compression',
    capabilityName: 'Reversible tool-output compression',
    summary:
      'A local rule-based post-tool compressor that retains changed raw output behind a recovery reference.',
    searchText:
      'ai coding agent codex command shell tool output compression context tokens reversible raw ref local hook cca',
    aliases: ['CCA', '@linger-alpha/cca', 'command compressor'],
    sourceUrl: 'https://github.com/linger-alpha/command-compressor-agent',
    sourceTitle: 'Command Compressor Agent repository',
    sourceOwner: 'linger-alpha',
    domainKey: 'context-code-intelligence',
  },
  {
    key: 'caveman',
    name: 'Caveman',
    kind: 'skill',
    capabilityKey: 'agent-output-brevity',
    capabilityName: 'Agent output brevity',
    summary:
      'An output-style skill that asks coding agents to compress narration while preserving exact code, commands, and errors.',
    searchText:
      'ai coding agent output tokens concise terse brevity style skill caveman narration compression',
    aliases: ['Caveman Mode', 'caveman output skill'],
    sourceUrl: 'https://github.com/JuliusBrussee/caveman',
    sourceTitle: 'Caveman repository',
    sourceOwner: 'Julius Brussee',
    domainKey: 'skills-plugins',
    additionalEvidence: [
      {
        url: 'https://blog.jetbrains.com/ai/2026/07/speak-to-ai-agents-like-cavemen-tosave-tokens/',
        title: 'Does Speaking to Agents Like Cavemen Really Save 65% of Tokens? We Test',
        owner: 'JetBrains',
        summary:
          'An independent paired SkillsBench evaluation measured a much smaller output-token reduction than the publisher headline and did not detect a quality difference in its tested configuration.',
        limitations: [
          'The benchmark forced activation on Claude Code; it does not measure normal Codex activation or input/tool-result savings.',
          'The study describes a ceiling for its tested tasks, not a universal savings rate.',
        ],
      },
    ],
  },
  {
    key: 'rtk',
    name: 'RTK',
    kind: 'cli',
    capabilityKey: 'command-output-rewriting',
    capabilityName: 'Command-output rewriting',
    summary:
      'A command wrapper that substitutes token-efficient output for supported developer-tool commands.',
    searchText:
      'ai coding agent command output filter rewrite context tokens rust cli rtk tests git build',
    aliases: ['Rust Token Killer', 'rtk token killer'],
    sourceUrl: 'https://github.com/rtk-ai/rtk',
    sourceTitle: 'RTK repository',
    sourceOwner: 'RTK AI',
    domainKey: 'context-code-intelligence',
    additionalEvidence: [
      {
        url: 'https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/',
        title: 'rtk Claude Code Token Savings: A Skill Trial Benchmark',
        owner: 'JetBrains',
        summary:
          'An independent paired task trial found no end-to-end token saving and a cost increase despite the tool reporting substantial avoided output.',
        limitations: [
          'The trial used Claude Code and its selected benchmark, model, effort, and integration path rather than Codex or Maestro.',
          'A negative aggregate result does not establish that every supported command or repository is harmed.',
        ],
      },
    ],
  },
  {
    key: 'tokf',
    name: 'tokf',
    kind: 'cli',
    capabilityKey: 'pretool-command-filtering',
    capabilityName: 'Pre-tool command filtering',
    summary:
      'A local command-output filter with a Codex pre-tool hook that can transparently rewrite supported shell commands.',
    searchText:
      'ai coding agent codex pretool hook command output filtering tokens shell transparent rust tokf',
    aliases: ['tokf command filter'],
    sourceUrl: 'https://github.com/mpecan/tokf',
    sourceTitle: 'tokf repository',
    sourceOwner: 'Milan Pecanov',
    domainKey: 'context-code-intelligence',
  },
  {
    key: 'sqz',
    name: 'sqz',
    kind: 'cli',
    capabilityKey: 'developer-output-compression',
    capabilityName: 'Developer-output compression',
    summary:
      'A command-line tool for compressing verbose developer-tool output before it enters an agent context.',
    searchText:
      'ai coding agent shell command output compression filter token context cli sqz build test logs',
    aliases: ['sqz output compressor'],
    sourceUrl: 'https://github.com/ojuschugh1/sqz',
    sourceTitle: 'sqz repository',
    sourceOwner: 'Ojus Chugh',
    domainKey: 'context-code-intelligence',
  },
  {
    key: 'repomix',
    name: 'Repomix',
    kind: 'cli',
    capabilityKey: 'bounded-repository-packaging',
    capabilityName: 'Bounded repository packaging',
    summary:
      'A repository packager with file selection, structure extraction, secret scanning, and explicit token budgets.',
    searchText:
      'ai coding repository context pack compression tree sitter token budget secret scan repomix map source',
    aliases: ['repository packer', 'Repomix MCP'],
    sourceUrl: 'https://github.com/yamadashy/repomix',
    sourceTitle: 'Repomix repository',
    sourceOwner: 'Kazuki Yamada',
    domainKey: 'context-code-intelligence',
  },
  {
    key: 'aider-repo-map',
    name: 'Aider Repository Map',
    kind: 'practice',
    capabilityKey: 'ranked-repository-mapping',
    capabilityName: 'Ranked repository mapping',
    summary:
      'A graph-ranked repository-map approach that selects important symbols under a configurable token budget.',
    searchText:
      'ai coding repository context map graph rank symbols pagerank token budget aider code navigation',
    aliases: ['Aider repo map', 'repository map'],
    sourceUrl: 'https://aider.chat/docs/repomap.html',
    sourceTitle: 'Aider repository map documentation',
    sourceOwner: 'Aider',
    domainKey: 'context-code-intelligence',
  },
  {
    key: 'llmlingua',
    name: 'LLMLingua',
    kind: 'model',
    capabilityKey: 'learned-prompt-compression',
    capabilityName: 'Learned prompt compression',
    summary:
      'A model-based prompt-compression toolkit with configurable context, sentence, and token-level filtering.',
    searchText:
      'ai llm prompt context compression learned model perplexity long context llmlingua token filtering',
    aliases: ['LongLLMLingua', 'LLMLingua-2'],
    sourceUrl: 'https://github.com/microsoft/LLMLingua',
    sourceTitle: 'LLMLingua repository',
    sourceOwner: 'Microsoft',
    domainKey: 'context-code-intelligence',
  },
  {
    key: 'agentpack',
    name: 'AgentPack',
    kind: 'plugin',
    capabilityKey: 'task-ranked-repository-context',
    capabilityName: 'Task-ranked repository context',
    summary:
      'A local context engine for ranking repository files, rules, commands, tests, and warnings for a stated task.',
    searchText:
      'ai coding agent repository context ranking files tests rules commands pack local handoff agentpack',
    aliases: ['AgentPack context engine'],
    sourceUrl: 'https://github.com/vishal2612200/agentpack',
    sourceTitle: 'AgentPack repository',
    sourceOwner: 'Vishal',
    domainKey: 'context-code-intelligence',
  },
  {
    key: 'aiboarding',
    name: 'AIBoarding',
    kind: 'plugin',
    capabilityKey: 'agent-instruction-lifecycle',
    capabilityName: 'Agent instruction lifecycle',
    summary:
      'A repository-onboarding workflow for generating, maintaining, compressing, and auditing agent instruction files.',
    searchText:
      'ai coding agent onboarding agents md instructions context drift audit hooks maintain compress aiboarding',
    aliases: ['AI Boarding', 'agent onboarding lifecycle'],
    sourceUrl: 'https://github.com/gustavo-meilus/aiboarding',
    sourceTitle: 'AIBoarding repository',
    sourceOwner: 'Gustavo Meilus',
    domainKey: 'skills-plugins',
  },
  {
    key: 'codex-rg-guard',
    name: 'Codex rg Guard',
    kind: 'plugin',
    capabilityKey: 'budgeted-repository-search',
    capabilityName: 'Budgeted repository search',
    summary:
      'A Codex-oriented guard for narrowing broad ripgrep or grep searches under an explicit result budget.',
    searchText:
      'ai coding codex repository search rg grep guard budget narrow output context tokens',
    aliases: ['codex-rg-guard', 'rg budget guard'],
    sourceUrl: 'https://github.com/Rycen7822/codex-rg-guard',
    sourceTitle: 'Codex rg Guard repository',
    sourceOwner: 'Rycen7822',
    domainKey: 'context-code-intelligence',
  },
  {
    key: 'context-guard',
    name: 'Context Guard',
    kind: 'plugin',
    capabilityKey: 'compaction-continuity',
    capabilityName: 'Compaction continuity',
    summary:
      'A Codex plugin intended to preserve authoritative requirements and verification evidence across long tasks and compaction.',
    searchText:
      'ai coding codex context compaction continuity requirements evidence long task resume guard memory',
    aliases: ['Codex Context Guard'],
    sourceUrl: 'https://github.com/GreenLv/codex-context-guard',
    sourceTitle: 'Context Guard repository',
    sourceOwner: 'GreenLv',
    domainKey: 'skills-plugins',
  },
  {
    key: 'rekall',
    name: 'Rekall',
    kind: 'plugin',
    capabilityKey: 'deliberate-thread-compaction',
    capabilityName: 'Deliberate thread compaction',
    summary:
      'A workflow for deliberate Codex thread compaction, verified handoff material, and one-time continuation.',
    searchText:
      'ai coding codex thread context compact compaction handoff resume continuation vscode rekall',
    aliases: ['Rekall Codex compaction'],
    sourceUrl: 'https://github.com/DitriXNew/rekall',
    sourceTitle: 'Rekall repository',
    sourceOwner: 'DitriXNew',
    domainKey: 'skills-plugins',
  },
  {
    key: 'simple-man',
    name: 'Simple Man',
    kind: 'skill',
    capabilityKey: 'loss-aware-response-brevity',
    capabilityName: 'Loss-aware response brevity',
    summary:
      'An agent response-style skill aimed at removing filler while retaining actionable facts and exact technical material.',
    searchText:
      'ai coding agent response output concise brevity style token filler preserve facts simple man',
    aliases: ['Simple Man output skill'],
    sourceUrl: 'https://github.com/Maksim-Burtsev/simple-man',
    sourceTitle: 'Simple Man repository',
    sourceOwner: 'Maksim Burtsev',
    domainKey: 'skills-plugins',
  },
  {
    key: 'gcf-proxy',
    name: 'GCF Proxy',
    kind: 'mcp_server',
    capabilityKey: 'mcp-response-encoding',
    capabilityName: 'MCP response encoding',
    summary:
      'A proxy that re-encodes structured MCP tool responses before they are returned to an agent.',
    searchText: 'ai coding agent mcp tool response json encoding compression proxy tokens gcf',
    aliases: ['GCF Codex Plugin'],
    sourceUrl: 'https://github.com/blackwell-systems/gcf-proxy',
    sourceTitle: 'GCF Proxy repository',
    sourceOwner: 'Blackwell Systems',
    domainKey: 'tool-agent-protocols',
  },
  {
    key: 'memi',
    name: 'memi',
    kind: 'plugin',
    capabilityKey: 'interface-design-memory',
    capabilityName: 'Interface and design-system memory',
    summary:
      'A local design-context and UI-audit toolkit for building reusable interface briefs for coding agents.',
    searchText:
      'ai coding agent frontend ui ux design system memory audit brief context screenshots tailwind memi',
    aliases: ['memi design', 'Memoire design tooling'],
    sourceUrl: 'https://github.com/sarveshsea/memi',
    sourceTitle: 'memi repository',
    sourceOwner: 'Sarvesh Sea',
    domainKey: 'skills-plugins',
  },
  {
    key: 'token-optimizer',
    name: 'token-optimizer',
    kind: 'mcp_server',
    capabilityKey: 'context-budgeted-file-tools',
    capabilityName: 'Context-budgeted file tools',
    summary:
      'An MCP toolkit for narrow file search, diff-oriented reads, caching, and stashing bulky material outside active context.',
    searchText:
      'ai coding agent mcp token context optimize file search diff cache stash output budget',
    aliases: ['token-optimizer MCP'],
    sourceUrl: 'https://github.com/ooples/token-optimizer-mcp',
    sourceTitle: 'token-optimizer MCP repository',
    sourceOwner: 'Ooples',
    domainKey: 'context-code-intelligence',
  },
  {
    key: 'tree-ring-memory',
    name: 'Tree Ring Memory',
    kind: 'plugin',
    capabilityKey: 'agent-memory-lifecycle',
    capabilityName: 'Agent memory lifecycle',
    summary:
      'A local-first agent-memory workflow with explicit recall, evidence, consolidation, audit, and forgetting stages.',
    searchText:
      'ai coding agent codex local memory lifecycle recall evidence consolidate audit forget tree ring',
    aliases: ['Tree Ring Memory Framework'],
    sourceUrl: 'https://github.com/TerminallyLazy/tree-ring-memory-codex-plugin',
    sourceTitle: 'Tree Ring Memory Codex plugin repository',
    sourceOwner: 'TerminallyLazy',
    domainKey: 'skills-plugins',
  },
  {
    key: 'codex-mem',
    name: 'Codex Mem',
    kind: 'plugin',
    capabilityKey: 'cross-session-agent-memory',
    capabilityName: 'Cross-session agent memory',
    summary:
      'A Codex plugin for capturing, compressing, and retrieving selected session context across later work.',
    searchText:
      'ai coding codex memory session context capture compress retrieve persistent local codex mem',
    aliases: ['codex-mem'],
    sourceUrl: 'https://github.com/2kDarki/codex-mem',
    sourceTitle: 'Codex Mem repository',
    sourceOwner: '2kDarki',
    domainKey: 'skills-plugins',
  },
  {
    key: 'context-pack',
    name: 'Context Pack',
    kind: 'plugin',
    capabilityKey: 'repository-briefing-generation',
    capabilityName: 'Repository briefing generation',
    summary:
      'A skill for generating a compact first-pass repository briefing before targeted source exploration.',
    searchText:
      'ai coding agent repository context pack briefing compact onboarding map first pass',
    aliases: ['context-pack'],
    sourceUrl: 'https://github.com/Rothschildiuk/context-pack',
    sourceTitle: 'Context Pack repository',
    sourceOwner: 'Rothschildiuk',
    domainKey: 'context-code-intelligence',
  },
  {
    key: 'deja',
    name: 'deja',
    kind: 'cli',
    capabilityKey: 'local-session-retrieval',
    capabilityName: 'Local session retrieval',
    summary:
      'A local index and search tool for retrieving prior coding-agent sessions without a model in the retrieval loop.',
    searchText:
      'ai coding agent session history search local index memory retrieval codex claude cursor deja',
    aliases: ['deja-vu session search'],
    sourceUrl: 'https://github.com/vshulcz/deja-vu',
    sourceTitle: 'deja repository',
    sourceOwner: 'vshulcz',
    domainKey: 'context-code-intelligence',
  },
  {
    key: 'context-compress',
    name: 'context-compress',
    kind: 'mcp_server',
    capabilityKey: 'indexed-tool-output-externalization',
    capabilityName: 'Indexed tool-output externalization',
    summary:
      'An MCP and hook toolkit that keeps large tool output in a searchable local index and returns bounded context.',
    searchText:
      'ai coding agent tool output context compression externalize index searchable mcp hook context compress',
    aliases: ['context-compress MCP'],
    sourceUrl: 'https://github.com/Open330/context-compress',
    sourceTitle: 'context-compress repository',
    sourceOwner: 'Open330',
    domainKey: 'context-code-intelligence',
  },
  {
    key: 'codex-memory-intelligence',
    name: 'Codex Memory Intelligence',
    kind: 'plugin',
    capabilityKey: 'evidence-backed-project-memory',
    capabilityName: 'Evidence-backed project memory',
    summary:
      'A local-first project-memory and code-intelligence layer that separates observations, reviewed knowledge, and advisory inference.',
    searchText:
      'ai coding codex project memory evidence decisions mistakes freshness provenance impact context local cmi',
    aliases: ['CMI', 'codex-memory-intelligence'],
    sourceUrl: 'https://github.com/lenhonbp/codex-memory-intelligence',
    sourceTitle: 'Codex Memory Intelligence repository',
    sourceOwner: 'lenhonbp',
    domainKey: 'context-code-intelligence',
  },
  {
    key: 'code-compression-bench',
    name: 'Code Compression Bench',
    kind: 'framework',
    capabilityKey: 'code-context-compression-evaluation',
    capabilityName: 'Code-context compression evaluation',
    summary:
      'A benchmark project for comparing code-context compression methods and downstream task behavior.',
    searchText:
      'ai coding repository context compression benchmark evaluation fidelity quality code compression bench',
    aliases: ['CCB', 'code-compression-bench'],
    sourceUrl: 'https://github.com/daseinlabs/code-compression-bench',
    sourceTitle: 'Code Compression Bench repository',
    sourceOwner: 'Dasein Labs',
    domainKey: 'observability-evaluation',
  },
  {
    key: 'tare',
    name: 'Tare',
    kind: 'cli',
    capabilityKey: 'code-context-reduction',
    capabilityName: 'Code-context reduction',
    summary:
      'A source-code reduction tool intended to preserve task-relevant structure while shrinking repository context.',
    searchText:
      'ai coding repository source code context reduce compress structure task relevant tare',
    aliases: ['Tare code context'],
    sourceUrl: 'https://github.com/mstuart/tare',
    sourceTitle: 'Tare repository',
    sourceOwner: 'mstuart',
    domainKey: 'context-code-intelligence',
  },
  {
    key: 'code-context-engine',
    name: 'Code Context Engine',
    kind: 'mcp_server',
    capabilityKey: 'semantic-code-context-retrieval',
    capabilityName: 'Semantic code-context retrieval',
    summary:
      'A code-context engine for indexing repositories and retrieving bounded task-relevant code through agent-facing tools.',
    searchText:
      'ai coding repository code context engine index semantic retrieval mcp agent search local',
    aliases: ['CCE', 'code-context-engine'],
    sourceUrl: 'https://github.com/elara-labs/code-context-engine',
    sourceTitle: 'Code Context Engine repository',
    sourceOwner: 'Elara Labs',
    domainKey: 'context-code-intelligence',
  },
  {
    key: 'openai-prompt-caching',
    name: 'OpenAI Prompt Caching',
    kind: 'practice',
    capabilityKey: 'cache-stable-context-layout',
    capabilityName: 'Cache-stable context layout',
    summary:
      'A prompt-layout practice that keeps reusable rendered prefixes stable so eligible requests can reuse cached computation.',
    searchText:
      'ai model prompt caching stable prefix context tokens cost cache breakpoint instructions tools openai',
    aliases: ['prompt caching', 'cache-stable prompts'],
    sourceUrl: 'https://developers.openai.com/api/docs/guides/prompt-caching',
    sourceTitle: 'OpenAI Prompt Caching guide',
    sourceOwner: 'OpenAI',
    domainKey: 'context-code-intelligence',
  },
  {
    key: 'codex-context-compaction',
    name: 'Codex Context Compaction',
    kind: 'practice',
    capabilityKey: 'agent-context-compaction',
    capabilityName: 'Agent context compaction',
    summary:
      'A Codex agent-loop mechanism that replaces older conversation input with a smaller continuation representation when context grows.',
    searchText:
      'ai coding codex agent context window compaction compact conversation continuation responses api',
    aliases: ['Codex auto compaction', 'Responses compact endpoint'],
    sourceUrl: 'https://openai.com/index/unrolling-the-codex-agent-loop/',
    sourceTitle: 'Unrolling the Codex agent loop',
    sourceOwner: 'OpenAI',
    domainKey: 'agent-control-planes',
  },
];

function id(kind: string, key: string): string {
  return stableUuid(namespace, `${kind}:${key}`);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function proposedValueProfile(evidenceId: string, kind: string): unknown[] {
  const highPrivilege = [
    'agent',
    'framework',
    'gateway',
    'mcp_server',
    'platform',
    'plugin',
    'runtime',
  ].includes(kind);
  return [
    {
      key: 'reuse_leverage',
      raw: 50,
      confidence: 0.35,
      coverage: 1,
      applicability: 'applicable',
      state: 'present',
      reasons: ['Publisher documentation supports only a proposed material-scope anchor.'],
      missing: ['Independent task evidence is not yet reviewed.'],
      evidenceIds: [evidenceId],
    },
    {
      key: 'adoption_ease',
      raw: null,
      confidence: 0,
      coverage: 0,
      applicability: 'applicable',
      state: 'missing',
      reasons: [],
      missing: ['Reference-environment setup and operating burden are not assessed.'],
      evidenceIds: [],
    },
    {
      key: 'maturity',
      raw: null,
      confidence: 0,
      coverage: 0,
      applicability: 'applicable',
      state: 'missing',
      reasons: [],
      missing: ['Kind-appropriate continuity evidence is not assessed.'],
      evidenceIds: [],
    },
    {
      key: 'provenance_clarity',
      raw: 50,
      confidence: 0.35,
      coverage: 1,
      applicability: 'applicable',
      highPrivilege,
      state: 'present',
      reasons: ['The publisher and canonical source are identifiable.'],
      missing: ['Consequential permissions and effects remain unreviewed.'],
      evidenceIds: [evidenceId],
    },
  ];
}

async function importProposedRecord(client: PoolClient, record: CorpusRecord): Promise<void> {
  const providerId = id('provider', record.key);
  const sourceId = id('source', record.sourceUrl);
  const observationId = id('observation', `${record.sourceUrl}:${observedAt}`);
  const evidenceId = id('evidence', `${record.key}:publisher-scope`);
  const capabilityId = id('capability', record.capabilityKey);
  const sourceDigest = hashCanonical({ url: record.sourceUrl, title: record.sourceTitle });
  const supplementalObservationIds: string[] = [];
  await client.query(
    `INSERT INTO catalog.sources
       (id, canonical_uri, title, owner, source_type, authority_scope, redistribution_notes)
     VALUES ($1, $2, $3, $4, 'official_or_project_documentation',
             'Publisher identity and stated project scope only',
             'Metadata and a bounded paraphrase only; source content is not mirrored.')
     ON CONFLICT (canonical_uri) DO NOTHING`,
    [sourceId, record.sourceUrl, record.sourceTitle, record.sourceOwner],
  );
  await client.query(
    `INSERT INTO catalog.source_observations
       (id, source_id, requested_uri, final_uri, observed_at, retrieval_method,
        adapter_version, content_digest, excerpt, media_type, trust_boundary, handling_status)
     VALUES ($1, $2, $3, $3, $4, 'phase06_source_register_review', 'phase06-corpus-v1',
             $5, $6, 'text/metadata', 'curated', 'normalized')
     ON CONFLICT DO NOTHING`,
    [observationId, sourceId, record.sourceUrl, observedAt, sourceDigest, record.summary],
  );
  await client.query(
    `INSERT INTO catalog.providers
       (id, kind, canonical_name, description, lifecycle_state, visibility, revision,
        created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'unknown', 'global', 1, $5, $5)
     ON CONFLICT (id) DO NOTHING`,
    [providerId, record.kind, record.name, record.summary, observedAt],
  );
  await client.query(
    `INSERT INTO catalog.provider_identities
       (id, provider_id, scheme, normalized_value, display_value, source_observation_id,
        confidence, is_canonical, valid_from)
     VALUES ($1, $2, 'canonical_document', $3, $3, $4, 1, true, $5)
     ON CONFLICT DO NOTHING`,
    [id('identity', record.key), providerId, record.sourceUrl, observationId, observedAt],
  );
  for (const alias of record.aliases) {
    await client.query(
      `INSERT INTO catalog.provider_aliases (id, provider_id, alias, source_observation_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT (provider_id, alias) DO NOTHING`,
      [id('alias', `${record.key}:${alias}`), providerId, alias, observationId],
    );
  }
  await client.query(
    `INSERT INTO catalog.capability_definitions
       (id, stable_key, schema_version, name, description, effect_classes)
     VALUES ($1, $2, 1, $3, $4, '{}')
     ON CONFLICT (stable_key, schema_version) DO NOTHING`,
    [capabilityId, record.capabilityKey, record.capabilityName, record.summary],
  );
  await client.query(
    `INSERT INTO catalog.provider_capabilities
       (id, provider_id, capability_definition_id, delivery_mode, maturity_state,
        assertion_state, effects, constraints)
     VALUES ($1, $2, $3, 'documented', 'unknown', 'publisher_declared', '{}', '{}'::jsonb)
     ON CONFLICT DO NOTHING`,
    [id('provider-capability', record.key), providerId, capabilityId],
  );
  const domain = await client.query<{ id: string }>(
    `SELECT id FROM catalog.domain_nodes WHERE stable_key = $1 ORDER BY id LIMIT 1`,
    [record.domainKey],
  );
  if (domain.rowCount) {
    await client.query(
      `INSERT INTO catalog.domain_memberships
         (id, provider_id, domain_node_id, origin, confidence, rationale, reviewed,
          source_observation_id)
       VALUES ($1, $2, $3, 'source', 0.35,
               'Proposed from the Phase 06 source-register scope; human review is pending.',
               false, $4)
       ON CONFLICT (provider_id, domain_node_id) DO NOTHING`,
      [id('domain', record.key), providerId, domain.rows[0]!.id, observationId],
    );
  }
  const claimId = id('claim', `${record.key}:documented-scope`);
  await client.query(
    `INSERT INTO catalog.claims
       (id, provider_id, source_observation_id, claimant, claimant_relation, predicate,
        value, scope, workflow_state, valid_from)
     VALUES ($1, $2, $3, $4, 'publisher', 'documented_capability_scope', $5,
             'Publisher description only; no efficacy or project-fit conclusion.', 'normalized', $6)
     ON CONFLICT DO NOTHING`,
    [claimId, providerId, observationId, record.sourceOwner, json(record.summary), observedAt],
  );
  await client.query(
    `INSERT INTO catalog.evidence_items
       (id, source_observation_id, evidence_type, producer, method_version, result,
        independence, applicability_scope, limitations, quality_flags, observed_at,
        review_after, visibility)
     VALUES ($1, $2, 'publisher_documentation', $3, 'phase06-corpus-v1', $4,
             'publisher_only', 'documented capability scope', $5, ARRAY['proposed'], $6,
             $6::timestamptz + interval '90 days', 'global')
     ON CONFLICT DO NOTHING`,
    [
      evidenceId,
      observationId,
      record.sourceOwner,
      json({ summary: record.summary }),
      ['Not independently tested; publication and semantic mapping remain proposed.'],
      observedAt,
    ],
  );
  await client.query(
    `INSERT INTO catalog.evidence_relations
       (id, claim_id, evidence_item_id, direction, directness, strength,
        applicability, rationale, reviewed_at)
     VALUES ($1, $2, $3, 'supports', 'direct', 'weak', 'partial',
             'Publisher documentation supports only the attributed scope.', $4)
     ON CONFLICT (claim_id, evidence_item_id, direction) DO NOTHING`,
    [id('evidence-relation', record.key), claimId, evidenceId, observedAt],
  );
  await client.query(
    `INSERT INTO catalog.provider_evidence_bindings
       (id, provider_id, evidence_item_id, applicability_scope, binding_basis)
     VALUES ($1, $2, $3, 'documented capability scope', 'claim_relation')
     ON CONFLICT (provider_id, evidence_item_id) DO NOTHING`,
    [id('provider-evidence', record.key), providerId, evidenceId],
  );
  for (const [index, evidence] of (record.additionalEvidence ?? []).entries()) {
    const additionalSourceId = id('source', evidence.url);
    const additionalObservationId = id('observation', `${evidence.url}:${observedAt}`);
    const additionalClaimId = id('claim', `${record.key}:independent-evaluation:${index}`);
    const additionalEvidenceId = id('evidence', `${record.key}:independent-evaluation:${index}`);
    supplementalObservationIds.push(additionalObservationId);
    await client.query(
      `INSERT INTO catalog.sources
         (id, canonical_uri, title, owner, source_type, authority_scope, redistribution_notes)
       VALUES ($1, $2, $3, $4, 'independent_evaluation',
               'Independent evaluation limited to its stated harness, tasks, model and configuration',
               'Metadata and a bounded paraphrase only; source content is not mirrored.')
       ON CONFLICT (canonical_uri) DO NOTHING`,
      [additionalSourceId, evidence.url, evidence.title, evidence.owner],
    );
    await client.query(
      `INSERT INTO catalog.source_observations
         (id, source_id, requested_uri, final_uri, observed_at, retrieval_method,
          adapter_version, content_digest, excerpt, media_type, trust_boundary, handling_status)
       VALUES ($1, $2, $3, $3, $4, 'phase06_source_register_review', 'phase06-corpus-v1',
               $5, $6, 'text/metadata', 'curated', 'normalized')
       ON CONFLICT DO NOTHING`,
      [
        additionalObservationId,
        additionalSourceId,
        evidence.url,
        observedAt,
        hashCanonical({ url: evidence.url, title: evidence.title, summary: evidence.summary }),
        evidence.summary,
      ],
    );
    await client.query(
      `INSERT INTO catalog.claims
         (id, provider_id, source_observation_id, claimant, claimant_relation, predicate,
          value, scope, workflow_state, valid_from)
       VALUES ($1, $2, $3, $4, 'independent', 'independent_evaluation_result', $5,
               'Only the documented evaluation configuration and measured outcome.',
               'normalized', $6)
       ON CONFLICT DO NOTHING`,
      [
        additionalClaimId,
        providerId,
        additionalObservationId,
        evidence.owner,
        json(evidence.summary),
        observedAt,
      ],
    );
    await client.query(
      `INSERT INTO catalog.evidence_items
         (id, source_observation_id, evidence_type, producer, method_version, result,
          independence, applicability_scope, limitations, quality_flags, observed_at,
          review_after, visibility)
       VALUES ($1, $2, 'independent_task_evaluation', $3, 'phase06-corpus-v1', $4,
               'independent', 'reported evaluation configuration only', $5,
               ARRAY['proposed_mapping'], $6, $6::timestamptz + interval '90 days', 'global')
       ON CONFLICT DO NOTHING`,
      [
        additionalEvidenceId,
        additionalObservationId,
        evidence.owner,
        json({ summary: evidence.summary }),
        evidence.limitations,
        observedAt,
      ],
    );
    await client.query(
      `INSERT INTO catalog.evidence_relations
         (id, claim_id, evidence_item_id, direction, directness, strength,
          applicability, rationale, reviewed_at)
       VALUES ($1, $2, $3, 'qualifies', 'direct', 'moderate', 'partial',
               'The evaluation qualifies publisher claims only within its recorded setup.', $4)
       ON CONFLICT (claim_id, evidence_item_id, direction) DO NOTHING`,
      [
        id('evidence-relation', `${record.key}:independent-evaluation:${index}`),
        additionalClaimId,
        additionalEvidenceId,
        observedAt,
      ],
    );
    await client.query(
      `INSERT INTO catalog.provider_evidence_bindings
         (id, provider_id, evidence_item_id, applicability_scope, binding_basis)
       VALUES ($1, $2, $3, 'reported independent evaluation configuration', 'claim_relation')
       ON CONFLICT (provider_id, evidence_item_id) DO NOTHING`,
      [
        id('provider-evidence', `${record.key}:independent-evaluation:${index}`),
        providerId,
        additionalEvidenceId,
      ],
    );
  }
  const display = {
    providerId,
    revision: 1,
    kind: record.kind,
    name: record.name,
    description: record.summary,
    lifecycleState: 'unknown',
  };
  await client.query(
    `INSERT INTO catalog.provider_display_revisions
       (id, provider_id, revision, kind, canonical_name, description, lifecycle_state,
        source_observation_id, capture_state, display_hash, effective_at)
     VALUES ($1, $2, 1, $3, $4, $5, 'unknown', $6, 'observed', $7, $8)
     ON CONFLICT (provider_id, revision) DO NOTHING`,
    [
      id('display', record.key),
      providerId,
      record.kind,
      record.name,
      record.summary,
      observationId,
      hashCanonical(display),
      observedAt,
    ],
  );
  const valueProfile = proposedValueProfile(evidenceId, record.kind);
  const projection = {
    providerId,
    providerRevision: 1,
    projectionVersion: 'knowledge-projection-v1',
    publicationState: 'proposed',
    preferredLabel: record.name,
    summary: record.summary,
    searchText: record.searchText,
    aliases: record.aliases,
    capabilityKeys: [record.capabilityKey],
    valueProfile,
  };
  const projectionId = id('projection', record.key);
  await client.query(
    `INSERT INTO catalog.knowledge_projections
       (id, provider_id, provider_revision, projection_version, publication_state,
        kind_profile, preferred_label, summary, search_text, aliases, capability_keys,
        value_profile, projection_hash, indexed_at)
     VALUES ($1, $2, 1, 'knowledge-projection-v1', 'proposed', $3, $4, $5, $6,
             $7, $8, $9, $10, $11)
     ON CONFLICT (provider_id, provider_revision, projection_version) DO NOTHING`,
    [
      projectionId,
      providerId,
      record.kind,
      record.name,
      record.summary,
      record.searchText,
      record.aliases,
      [record.capabilityKey],
      json(valueProfile),
      hashCanonical(projection),
      observedAt,
    ],
  );
  await client.query(
    `INSERT INTO catalog.knowledge_projection_sources
       (projection_id, source_observation_id, role, source_anchor)
     VALUES ($1, $2, 'capability', 'Publisher description and canonical identity')
     ON CONFLICT DO NOTHING`,
    [projectionId, observationId],
  );
  for (const supplementalObservationId of supplementalObservationIds) {
    await client.query(
      `INSERT INTO catalog.knowledge_projection_sources
         (projection_id, source_observation_id, role, source_anchor)
       VALUES ($1, $2, 'caveat', 'Independent evaluation with scoped limitations')
       ON CONFLICT DO NOTHING`,
      [projectionId, supplementalObservationId],
    );
  }
}

export async function importPhase06Knowledge(client: PoolClient): Promise<void> {
  const policyId = id('policy', querySignalPolicyV1.version);
  await client.query(
    `INSERT INTO catalog.score_policies
       (id, policy_key, version, policy_document, code_revision, created_at)
     VALUES ($1, 'query-signal', $2, $3, 'phase-06', $4)
     ON CONFLICT (policy_key, version) DO NOTHING`,
    [policyId, querySignalPolicyV1.version, json(querySignalPolicyV1), observedAt],
  );

  // Migration backfills retained rows. This path furnishes records inserted
  // after a fresh migration, preserving the same relational invariants.
  await client.query(`
    INSERT INTO catalog.provider_display_revisions
      (id, provider_id, revision, kind, canonical_name, description, lifecycle_state,
       capture_state, display_hash, effective_at)
    SELECT
      ('50000000' || substr(md5('phase06-display:' || p.id::text || ':' || p.revision::text), 9))::uuid,
      p.id, p.revision, p.kind, p.canonical_name, p.description, p.lifecycle_state,
      'reviewed', encode(digest(convert_to(jsonb_build_object(
        'providerId', p.id, 'revision', p.revision, 'kind', p.kind, 'name', p.canonical_name,
        'description', p.description, 'lifecycleState', p.lifecycle_state
      )::text, 'UTF8'), 'sha256'), 'hex'), p.updated_at
    FROM catalog.providers p
    ON CONFLICT (provider_id, revision) DO NOTHING
  `);
  await client.query(`
    INSERT INTO catalog.provider_evidence_bindings
      (id, provider_id, evidence_item_id, applicability_scope, binding_basis, reviewed_at)
    SELECT DISTINCT ON (c.provider_id, er.evidence_item_id)
      ('60000000' || substr(md5('phase06-provider-evidence:' || c.provider_id::text || ':' || er.evidence_item_id::text), 9))::uuid,
      c.provider_id, er.evidence_item_id, c.scope, 'claim_relation', er.reviewed_at
    FROM catalog.evidence_relations er
    JOIN catalog.claims c ON c.id = er.claim_id
    ORDER BY c.provider_id, er.evidence_item_id, er.reviewed_at DESC
    ON CONFLICT (provider_id, evidence_item_id) DO NOTHING
  `);
  await client.query(`
    INSERT INTO catalog.score_run_evidence_bindings
      (score_run_id, provider_id, evidence_item_id, applicability_scope)
    SELECT sr.id, sr.provider_id, evidence_id, sr.scope_key
    FROM catalog.score_runs sr
    CROSS JOIN LATERAL unnest(sr.evidence_ids) AS evidence_id
    JOIN catalog.provider_evidence_bindings peb
      ON peb.provider_id = sr.provider_id AND peb.evidence_item_id = evidence_id
    ON CONFLICT DO NOTHING
  `);
  await client.query(`
    INSERT INTO catalog.dimension_score_evidence_bindings
      (dimension_score_id, score_run_id, provider_id, evidence_item_id, applicability_scope)
    SELECT ds.id, sr.id, sr.provider_id, evidence_id, ds.dimension_key
    FROM catalog.dimension_scores ds
    JOIN catalog.score_runs sr ON sr.id = ds.score_run_id
    CROSS JOIN LATERAL unnest(ds.evidence_ids) AS evidence_id
    JOIN catalog.provider_evidence_bindings peb
      ON peb.provider_id = sr.provider_id AND peb.evidence_item_id = evidence_id
    ON CONFLICT DO NOTHING
  `);
  await client.query(`
    INSERT INTO catalog.verification_evidence_bindings
      (verification_assessment_id, provider_id, evidence_item_id, applicability_scope)
    SELECT va.id, va.provider_id, evidence_id, va.scope
    FROM catalog.verification_assessments va
    CROSS JOIN LATERAL unnest(va.evidence_ids) AS evidence_id
    JOIN catalog.provider_evidence_bindings peb
      ON peb.provider_id = va.provider_id AND peb.evidence_item_id = evidence_id
    ON CONFLICT DO NOTHING
  `);
  await client.query(`
    INSERT INTO catalog.compatibility_evidence_bindings
      (compatibility_id, provider_id, evidence_item_id, applicability_scope)
    SELECT pc.id, pc.provider_id, evidence_id, pc.compatibility_key
    FROM catalog.provider_compatibility pc
    CROSS JOIN LATERAL unnest(pc.evidence_ids) AS evidence_id
    JOIN catalog.provider_evidence_bindings peb
      ON peb.provider_id = pc.provider_id AND peb.evidence_item_id = evidence_id
    ON CONFLICT DO NOTHING
  `);
  await client.query(`
    INSERT INTO workspace.project_display_revisions
      (id, workspace_id, project_id, revision, name, lifecycle_state, capture_state,
       display_hash, created_at)
    SELECT
      ('70000000' || substr(md5('phase06-project-display:' || p.id::text), 9))::uuid,
      p.workspace_id, p.id, 1, p.name, p.lifecycle_state, 'authored',
      encode(digest(convert_to(jsonb_build_object(
        'projectId', p.id, 'revision', 1, 'name', p.name, 'lifecycleState', p.lifecycle_state
      )::text, 'UTF8'), 'sha256'), 'hex'), p.created_at
    FROM workspace.projects p
    ON CONFLICT (project_id, revision) DO NOTHING
  `);

  const existing = await client.query<{
    id: string;
    revision: number;
    kind: string;
    name: string;
    description: string;
    aliases: string[];
    capabilities: string[];
    observationIds: string[];
    dimensions: Array<{
      key: string;
      raw: number | null;
      confidence: number;
      coverage: number;
      state: string;
      evidenceIds: string[];
    }>;
  }>(`
    SELECT p.id, p.revision, p.kind, p.canonical_name AS name, p.description,
      COALESCE((SELECT array_agg(pa.alias ORDER BY pa.alias)
                FROM catalog.provider_aliases pa WHERE pa.provider_id = p.id), '{}') AS aliases,
      COALESCE((SELECT array_agg(cd.stable_key ORDER BY cd.stable_key)
                FROM catalog.provider_capabilities pc
                JOIN catalog.capability_definitions cd ON cd.id = pc.capability_definition_id
                WHERE pc.provider_id = p.id), '{}') AS capabilities,
      COALESCE((SELECT array_agg(DISTINCT c.source_observation_id ORDER BY c.source_observation_id)
                FROM catalog.claims c WHERE c.provider_id = p.id), '{}') AS "observationIds",
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
                  'key', ds.dimension_key, 'raw', ds.raw::float8,
                  'confidence', ds.confidence::float8, 'coverage', ds.coverage::float8,
                  'state', ds.state, 'evidenceIds', ds.evidence_ids))
                FROM catalog.dimension_scores ds
                WHERE ds.score_run_id = (
                  SELECT sr.id FROM catalog.score_runs sr
                  WHERE sr.provider_id = p.id AND sr.scope_key = 'general'
                  ORDER BY sr.generated_at DESC, sr.id DESC LIMIT 1
                )), '[]'::jsonb) AS dimensions
    FROM catalog.providers p
    WHERE NOT EXISTS (
      SELECT 1 FROM catalog.knowledge_projections kp WHERE kp.provider_id = p.id
    )
    ORDER BY p.canonical_name
  `);
  for (const provider of existing.rows) {
    const dimension = (key: string) => provider.dimensions.find((item) => item.key === key);
    const asValue = (key: string, sourceKey: string, reason: string, highPrivilege = false) => {
      const source = dimension(sourceKey);
      return source && source.raw !== null
        ? {
            key,
            raw: source.raw,
            confidence: source.confidence,
            coverage: source.coverage,
            applicability: 'applicable',
            highPrivilege,
            state: source.state,
            reasons: [reason],
            missing: [],
            evidenceIds: source.evidenceIds,
          }
        : {
            key,
            raw: null,
            confidence: 0,
            coverage: 0,
            applicability: 'applicable',
            highPrivilege,
            state: 'missing',
            reasons: [],
            missing: [`${reason} is not established by the reviewed source set.`],
            evidenceIds: [],
          };
    };
    const highPrivilege = [
      'agent',
      'framework',
      'gateway',
      'mcp_server',
      'platform',
      'plugin',
      'runtime',
    ].includes(provider.kind);
    const valueProfile = [
      asValue(
        'reuse_leverage',
        'domain_confidence',
        'The reviewed capability-to-domain mapping supplies the initial reuse-scope anchor.',
      ),
      {
        key: 'adoption_ease',
        raw: null,
        confidence: 0,
        coverage: 0,
        applicability: 'applicable',
        state: 'missing',
        reasons: [],
        missing: ['Generic setup and operating burden are not assessed in the v0 record.'],
        evidenceIds: [],
      },
      asValue(
        'maturity',
        'maturity',
        'The kind-specific v0 maturity assessment is reused with its original confidence.',
      ),
      asValue(
        'provenance_clarity',
        'security_provenance',
        'The v0 security/provenance assessment is reused only for scoped provenance clarity.',
        highPrivilege,
      ),
    ];
    const projection = {
      providerId: provider.id,
      providerRevision: provider.revision,
      name: provider.name,
      summary: provider.description,
      aliases: provider.aliases,
      capabilities: provider.capabilities,
      valueProfile,
    };
    const projectionId = id('projection', provider.id);
    await client.query(
      `INSERT INTO catalog.knowledge_projections
         (id, provider_id, provider_revision, projection_version, publication_state,
          kind_profile, preferred_label, summary, search_text, aliases, capability_keys,
          value_profile, projection_hash, indexed_at)
       VALUES ($1, $2, $3, 'knowledge-projection-v1', 'reviewed', $4, $5, $6, $7,
               $8, $9, $10, $11, $12)
       ON CONFLICT (provider_id, provider_revision, projection_version) DO NOTHING`,
      [
        projectionId,
        provider.id,
        provider.revision,
        provider.kind,
        provider.name,
        provider.description,
        `${provider.name} ${provider.description} ${provider.aliases.join(' ')} ${provider.capabilities.join(' ')}`,
        provider.aliases,
        provider.capabilities,
        json(valueProfile),
        hashCanonical(projection),
        observedAt,
      ],
    );
    for (const observationId of provider.observationIds) {
      await client.query(
        `INSERT INTO catalog.knowledge_projection_sources
           (projection_id, source_observation_id, role, source_anchor)
         VALUES ($1, $2, 'capability', 'Reviewed v0 capability and claim source')
         ON CONFLICT DO NOTHING`,
        [projectionId, observationId],
      );
    }
  }

  for (const record of phase06CorpusV1) await importProposedRecord(client, record);
  for (const record of discoveryCorpusV1) await importProposedRecord(client, record);
}
