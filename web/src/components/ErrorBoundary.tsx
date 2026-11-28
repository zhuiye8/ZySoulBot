import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from './ui.tsx'

interface Props {
  children: ReactNode
  resetKey?: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(prevProps: Props): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // 交给界面错误面板展示，避免整页白屏
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          role="alert"
          className="ui-panel p-6 space-y-3"
          style={{ borderColor: 'var(--danger-border)' }}
        >
          <div className="flex items-center gap-2 text-[15px] font-semibold" style={{ color: 'var(--danger-fg)' }}>
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
            页面渲染遇到异常
          </div>
          <p className="text-[13px]" style={{ color: 'var(--gray-11)' }}>
            当前视图发生意外错误，你可以点击下方按钮重新渲染，或切换至其他页面。
          </p>
          <pre
            className="text-[12px] font-mono-num p-3 rounded-[8px] overflow-x-auto m-0"
            style={{ backgroundColor: 'var(--surface-subtle)', color: 'var(--gray-11)' }}
          >
            {this.state.error.message}
          </pre>
          <div>
            <Button variant="primary" size="sm" onClick={() => this.setState({ error: null })}>
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              重新渲染
            </Button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
