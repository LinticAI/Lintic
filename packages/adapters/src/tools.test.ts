import { describe, test, expect } from 'vitest';
import { TOOLS, toOpenAITools, toAnthropicTools } from './tools.js';

describe('TOOLS', () => {
  test('contains exactly 5 tool definitions', () => {
    expect(TOOLS).toHaveLength(5);
  });

  test('includes all expected tool names', () => {
    const names = TOOLS.map(t => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('run_command');
    expect(names).toContain('list_directory');
    expect(names).toContain('search_files');
  });
});

describe('toOpenAITools', () => {
  test('wraps each tool as a function type', () => {
    const result = toOpenAITools(TOOLS);
    expect(result).toHaveLength(TOOLS.length);
    result.forEach(t => expect(t.type).toBe('function'));
  });

  test('maps name, description into function definition', () => {
    const [first] = toOpenAITools(TOOLS);
    expect(first!.function.name).toBe('read_file');
    expect(first!.function.description).toContain('Read');
  });

  test('wraps parameters under object schema', () => {
    const [first] = toOpenAITools(TOOLS);
    expect(first!.function.parameters.type).toBe('object');
    expect(first!.function.parameters.properties).toHaveProperty('path');
    expect(first!.function.parameters.required).toContain('path');
  });
});

describe('toAnthropicTools', () => {
  test('produces one entry per tool', () => {
    const result = toAnthropicTools(TOOLS);
    expect(result).toHaveLength(TOOLS.length);
  });

  test('maps name and description directly', () => {
    const [first] = toAnthropicTools(TOOLS);
    expect(first!.name).toBe('read_file');
    expect(first!.description).toContain('Read');
  });

  test('uses input_schema with object type', () => {
    const [first] = toAnthropicTools(TOOLS);
    expect(first!.input_schema.type).toBe('object');
    expect(first!.input_schema.properties).toHaveProperty('path');
    expect(first!.input_schema.required).toContain('path');
  });
});
