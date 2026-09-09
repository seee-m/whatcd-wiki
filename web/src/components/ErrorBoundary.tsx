import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

// Without this, any uncaught render/effect error anywhere in the tree
// unmounts the whole app to a blank white screen (React 18 default) --
// this at least leaves a visible, recoverable fallback.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error(error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '3rem 1rem', textAlign: 'center' }}>
          <p>Something went wrong loading this page.</p>
          <p>
            <a href="/">Reload</a>
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
