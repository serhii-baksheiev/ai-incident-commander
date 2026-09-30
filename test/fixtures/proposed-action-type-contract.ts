/**
 * AIC-21 slice 2: the compile-time half of the ProposedAction record
 * contract. The record is a discriminated union on `actionType`, so the type
 * narrows `params` by `actionType`, and a type the registry does not list as
 * safe-write is not an `actionType` at all.
 *
 * A real value, not a `declare`: like its sibling fixtures, `test/fixtures`
 * is swept by node's default test-file discovery, so this file is also
 * EXECUTED with its types stripped — every binding below must be valid plain
 * JavaScript too. No `node:` import: it is compiled standalone,
 * `--ignoreConfig`, with no `@types/node` in scope.
 */
import type { ProposedActionRecord } from '@aic/domain';

type ActionType = ProposedActionRecord['actionType'];

const registered: ActionType = 'incident-comment';
// @ts-expect-error — a dangerous or unregistered id is not a record actionType.
const unregistered: ActionType = 'restart-service';

function titleOf(record: ProposedActionRecord): string | undefined {
  if (record.actionType === 'create-follow-up-ticket') {
    // Narrowed: only the ticket params carry `title`.
    return record.params.title;
  }
  // @ts-expect-error — incident-comment params carry no `title`.
  return record.params.title;
}

void registered;
void unregistered;
void titleOf;
