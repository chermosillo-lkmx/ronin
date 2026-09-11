import { Component, type ReactNode } from "react";

/**
 * Un error de render en cualquier vista dejaba la app ENTERA en blanco (React desmonta el árbol
 * completo si nadie lo atrapa): pasó con una propuesta legada cuyo verifyAfter no era lista. La
 * frontera aísla cada región (workspace, inspector, contexto) y ofrece reintentar; el `key={view}`
 * en el montaje hace que cambiar de vista la reinicie sola.
 */
interface State { error: string | null }

export function ViewErrorFallback({ label, error, onRetry }: { label: string; error: string | null; onRetry: () => void }) {
  return (
    <div className="ronin-view-error" role="alert">
      <span className="ronin-eyebrow">{label}</span>
      <h2>Esta parte de la pantalla falló al pintarse</h2>
      <p>El resto de la app sigue funcionando. Si vuelve a pasar, copia el detalle al reportarlo.</p>
      <code>{error}</code>
      <button className="n-btn n-btn-secondary" onClick={onRetry}>Reintentar</button>
    </div>
  );
}

export class ViewErrorBoundary extends Component<{ label: string; children?: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }

  componentDidCatch(error: unknown): void {
    console.error(`[ronin] la vista "${this.props.label}" falló al pintarse`, error);
  }

  render() {
    if (this.state.error !== null) {
      return <ViewErrorFallback label={this.props.label} error={this.state.error} onRetry={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}
