import Editor from '@monaco-editor/react';
import { languageFromPath } from '../lib/languageFromPath.js';

interface MonacoEditorProps {
  filePath: string;
  content: string;
  onChange: (value: string) => void;
}

export function MonacoEditor({ filePath, content, onChange }: MonacoEditorProps) {
  return (
    <Editor
      height="100%"
      theme="vs-dark"
      language={languageFromPath(filePath)}
      value={content}
      onChange={(value) => onChange(value ?? '')}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        tabSize: 2,
      }}
    />
  );
}
