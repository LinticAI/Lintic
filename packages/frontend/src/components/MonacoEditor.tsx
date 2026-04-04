import { useEffect, useState } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import { languageFromPath } from '../lib/languageFromPath.js';

// Pre-define themes so they're ready when the editor mounts.
loader.init().then((monaco) => {
  monaco.editor.defineTheme('lintic-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#FFFFFF',
      'editor.lineHighlightBackground': '#FFFBF7',
      'editorLineNumber.foreground': '#CBC5D1',
      'editorLineNumber.activeForeground': '#1A1520',
      'editorIndentGuide.background': '#F5F0EB',
      'editorIndentGuide.activeBackground': '#3887ce',
    },
  });
  monaco.editor.defineTheme('lintic-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#0a0a0a',
      'editor.lineHighlightBackground': '#1a1a1a',
      'editorLineNumber.foreground': '#444444',
      'editorLineNumber.activeForeground': '#888888',
      'editorIndentGuide.background': '#1a1a1a',
      'editorIndentGuide.activeBackground': '#333333',
    },
  });
});

interface MonacoEditorProps {
  filePath: string;
  content: string;
  onChange: (value: string) => void;
}

export function MonacoEditor({ filePath, content, onChange }: MonacoEditorProps) {
  const [theme, setTheme] = useState('lintic-light');

  useEffect(() => {
    // Determine initial theme
    const isDark = document.documentElement.classList.contains('dark');
    setTheme(isDark ? 'lintic-dark' : 'lintic-light');

    // Watch for theme changes on documentElement
    const observer = new MutationObserver(() => {
      const currentIsDark = document.documentElement.classList.contains('dark');
      setTheme(currentIsDark ? 'lintic-dark' : 'lintic-light');
    });

    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return (
    <Editor
      height="100%"
      theme={theme}
      language={languageFromPath(filePath)}
      value={content}
      onChange={(value) => onChange(value ?? '')}
      loading={<div className="h-full w-full" style={{ background: theme === 'lintic-dark' ? '#0a0a0a' : '#FFFFFF' }} />}
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
