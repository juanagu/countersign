import { useRef } from 'react';
import { Button } from '../../shared/ui/button';
import '../../shared/ui/card.css';
import { cancelTransfer, type OnDecide } from './lib/approval-decision';

export interface MissingDraftCardProps {
  onDecide: OnDecide;
}

/** The bot paused for a draft whose confirm card isn't in the thread: nothing to show, so it can only be dropped. */
export function MissingDraftCard({ onDecide }: MissingDraftCardProps) {
  const inFlight = useRef(false);
  return (
    <section className="gen-card" aria-label="Transferencia sin borrador">
      <p>No encontramos el borrador de esta transferencia.</p>
      <Button variant="secondary" onClick={() => void cancelTransfer(inFlight, onDecide)}>
        Descartar
      </Button>
    </section>
  );
}
