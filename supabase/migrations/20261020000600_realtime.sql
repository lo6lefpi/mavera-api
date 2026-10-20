-- =============================================================================
-- Temps réel : seulement les tables que l'application affiche en direct.
-- Pas de facturation (abonnements, forfaits, Stripe) ni de journal.
-- La RLS s'applique aussi aux changements diffusés : un client ne reçoit que
-- ceux de son dossier. Le filtre .eq() de l'application réduit le volume, il
-- ne protège rien.
-- =============================================================================
alter publication supabase_realtime add table
  public.messages,
  public.question_messages,
  public.request_messages,
  public.questions,
  public.question_answers,
  public.document_requests,
  public.request_documents,
  public.documents,
  public.notifications,
  public.proposals,
  public.proposal_responses,
  public.mandates,
  public.mandate_closures;
