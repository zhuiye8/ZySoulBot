import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'

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
    // 交给界面卡片优雅展示，不白屏崩溃
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="acg-card p-6 space-y-3" style={{ borderColor: 'var(--danger)' }}>
          <div className="flex items-center gap-2 font-semibold" style={{ color: 'var(--danger)' }}>
            <AlertTriangle className="w-5 h-5" />
            页面渲染遇到一点小状况
          </div>
          <p className="text-xs font-mono-num p-3 rounded-xl overflow-x-auto" style={{ backgroundColor: 'var(--surface-2)', color: 'var(--text-2)' }}>
            {this.state.error.message}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="acg-btn acg-btn-primary text-xs"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            重试渲染
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
