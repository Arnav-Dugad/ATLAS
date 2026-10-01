import { Component, type ErrorInfo, type ReactNode } from "react";
import s from "./primitives.module.css";

interface Props {
  /** Short name of the region, used in the fallback ("Globe", "Incident panel"). */
  region: string;
  children: ReactNode;
  /** Optional custom fallback; receives a reset callback. */
  fallback?: (reset: () => void, error: Error) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Contains failures to one region of the interface. A crash in the 3D globe must never take
 * the incident stream, search or sources down with it.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ATLAS] ${this.props.region} failed`, error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.reset, error);
    return (
      <div className={`${s.empty} ${s.error}`} role="alert">
        <div className={s.emptyTitle}>{this.props.region} hit an unexpected error</div>
        <div className={s.emptyBody}>The rest of ATLAS keeps working. Details are in the browser console.</div>
        <button type="button" className={s.ghostBtn} onClick={this.reset}>
          Reload {this.props.region.toLowerCase()}
        </button>
      </div>
    );
  }
}
