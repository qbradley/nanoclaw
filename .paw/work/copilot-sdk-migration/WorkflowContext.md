# WorkflowContext

Work Title: Copilot SDK Migration
Work ID: copilot-sdk-migration
Base Branch: main
Target Branch: feature/copilot-sdk-migration
Workflow Mode: full
Review Strategy: local
Review Policy: milestones
Session Policy: continuous
Final Agent Review: enabled
Final Review Mode: multi-model
Final Review Interactive: true
Final Review Models: latest GPT, latest Gemini, latest Claude Opus
Custom Workflow Instructions: none
Initial Prompt: Convert NanoClaw to use GitHub Copilot SDK (@github/copilot-sdk) instead of Claude Agent SDK (@anthropic-ai/claude-agent-sdk). Keep container isolation, map session persistence to Copilot SDK's resumeSession(), keep MCP server as-is, support GitHub auth by default with BYOK fallback.
Issue URL: none
Remote: origin
Artifact Paths: auto-derived
Additional Inputs: none
