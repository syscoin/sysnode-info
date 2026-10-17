import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import ProposalVoteModal from './ProposalVoteModal';
import PaliVoteModal from './PaliVoteModal';
import VotingDialog from './VotingDialog';

export default function VoteMethodModal({ proposal, onClose, onReloadProposals }) {
  const { user, isAuthenticated } = useAuth();
  const [method, setMethod] = useState(null);
  const scope = JSON.stringify([user?.id, user?.email, isAuthenticated, proposal?.Key]);
  const initialScope = useRef(scope);
  useEffect(() => { if (initialScope.current !== scope) onClose(); }, [scope, onClose]);
  if (!isAuthenticated || initialScope.current !== scope) return null;
  if (method === 'browser') return <ProposalVoteModal open proposal={proposal} onClose={onClose} onReloadProposals={onReloadProposals} />;
  if (method === 'pali') return <PaliVoteModal proposal={proposal} onClose={onClose} onBack={() => setMethod(null)} onReloadProposals={onReloadProposals} />;
  return <VotingDialog title="Choose where your voting keys stay" onClose={onClose}>
    <p className="pali-vote__proposal">{String(proposal.title || proposal.name || 'Proposal').slice(0, 160)}</p>
    <div className="pali-vote__methods">
      <button type="button" className="pali-vote__method" onClick={() => setMethod('pali')}><strong>Pali wallet</strong><span>Approve selected nodes in Pali. Voting keys never enter this website.</span></button>
      <button type="button" className="pali-vote__method" onClick={() => setMethod('browser')}><strong>Browser voting vault</strong><span>Use the existing encrypted vault, including voting from your phone.</span></button>
    </div>
    <p className="vote-modal__hint">These are separate choices. Selecting one never copies keys from the other. Watching a node does not grant voting or administration authority.</p>
  </VotingDialog>;
}
