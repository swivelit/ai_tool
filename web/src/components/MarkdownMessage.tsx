import { useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import typescript from 'highlight.js/lib/languages/typescript'
import 'highlight.js/styles/github-dark-dimmed.css'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('python', python)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)

export function MarkdownMessage({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: props => <a {...props} target="_blank" rel="noreferrer" />,
    code: ({ className, children: codeChildren, ...props }) => {
      const value = String(codeChildren).replace(/\n$/, '')
      const block = Boolean(className) || value.includes('\n')
      return block ? <CodeBlock className={className}>{value}</CodeBlock> : <code {...props}>{codeChildren}</code>
    },
  }}>{children}</ReactMarkdown>
}

function CodeBlock({ children, className }: { children: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const codeRef = useRef<HTMLElement>(null)
  const language = className?.replace('language-', '') || 'code'
  useEffect(() => { if (codeRef.current) hljs.highlightElement(codeRef.current) }, [children, className])
  return <div className="code-block">
    <div className="code-head"><span>{language}</span><button onClick={() => void navigator.clipboard.writeText(children).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) })}>{copied ? 'Copied' : 'Copy code'}</button></div>
    <pre><code ref={codeRef} className={className}>{children as ReactNode}</code></pre>
  </div>
}
