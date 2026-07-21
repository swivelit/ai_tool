import { memo, useMemo, useState } from 'react'
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
hljs.registerAliases(['sh', 'shell'], { languageName: 'bash' })
hljs.registerAliases('py', { languageName: 'python' })

export const MarkdownMessage = memo(function MarkdownMessage({ children, streaming = false }: { children: string; streaming?: boolean }) {
  const components = useMemo(() => ({
    a: (props: React.ComponentPropsWithoutRef<'a'>) => <a {...props} target="_blank" rel="noreferrer" />,
    code: ({ className, children: codeChildren, ...props }: React.ComponentPropsWithoutRef<'code'>) => {
      const value = String(codeChildren).replace(/\n$/, '')
      const block = Boolean(className) || value.includes('\n')
      return block ? <CodeBlock className={className} streaming={streaming}>{value}</CodeBlock> : <code {...props}>{codeChildren}</code>
    },
  }), [streaming])
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{children}</ReactMarkdown>
})

function CodeBlock({ children, className, streaming }: { children: string; className?: string; streaming: boolean }) {
  const [copied, setCopied] = useState(false)
  const language = className?.replace('language-', '') || 'code'
  const highlighted = useMemo(() => {
    if (streaming || language === 'code' || !hljs.getLanguage(language)) return null
    return hljs.highlight(children, { language, ignoreIllegals: true }).value
  }, [children, language, streaming])
  return <div className="code-block">
    <div className="code-head"><span>{language}</span><button onClick={() => void navigator.clipboard.writeText(children).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) })}>{copied ? 'Copied' : 'Copy code'}</button></div>
    <pre>{highlighted === null
      ? <code className={className}>{children}</code>
      : <code className={[className, 'hljs'].filter(Boolean).join(' ')} dangerouslySetInnerHTML={{ __html:highlighted }} />}</pre>
  </div>
}
