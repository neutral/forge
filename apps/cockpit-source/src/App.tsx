import { StrictMode, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  Button, Dialog, DialogTrigger, Disclosure, DisclosurePanel, Form, Heading, I18nProvider, Input, Label, Link,
  ListBox, ListBoxItem, Modal, ModalOverlay, Radio, RadioGroup, RouterProvider, Tab, TabList, TabPanel, Tabs, Text,
  TextArea, TextField,
} from 'react-aria-components';
import { draftOf, isView, workerModeOf, type Cockpit, type CockpitState, type Detail, type Progress, type StoredFile } from './cockpit.ts';
import { clock, decodeFile, patchLine, time, workerState, type State } from './presentation.ts';

function useStore<T>(store: { subscribe: (listener: () => void) => () => void; getSnapshot: () => T }): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** One cockpit tree for the prerendered first paint and the hydrated page. */
export function Root({ cockpit }: { cockpit: Cockpit }) {
  return (
    <StrictMode>
      <I18nProvider locale="en-US">
        <RouterProvider navigate={cockpit.follow}>
          <Sheet cockpit={cockpit} />
        </RouterProvider>
      </I18nProvider>
    </StrictMode>
  );
}

/** A mark a word beside it repeats; assistive technology reads the word. */
function Mark({ children }: { children: string }) {
  return <span className="mark" aria-hidden="true">{children}</span>;
}
function StateLine({ state, className = 'state' }: { state: State; className?: string }) {
  return <span className={`${className}${state.attend ? ' attend' : ''}`}><Mark>{state.mark}</Mark>{state.word}</span>;
}
/** A part's title: its name in capitals and a rule drawn out to its edge, with an optional count. */
function PartTitle({ id, level = 3, count, children }: { id: string; level?: 2 | 3; count?: string; children: string }) {
  const Title = level === 2 ? 'h2' : 'h3';
  return <div className="part-title"><Title id={id}>{children}</Title>{count ? <span className="count">{count}</span> : null}</div>;
}
function Failure({ children }: { children: string }) {
  return <p className="notice notice-error"><Mark>△</Mark>{children}</p>;
}
function Empty({ title, children }: { title: string; children?: string }) {
  return <div className="empty-state"><p className="empty-title">{title}</p>{children ? <p>{children}</p> : null}</div>;
}

function Sheet({ cockpit }: { cockpit: Cockpit }) {
  const state = useStore(cockpit);
  useEffect(() => {
    void cockpit.start();
    return () => { cockpit.stop(); };
  }, [cockpit]);
  return (
    <>
      <Link className="skip-link" href="#main">Skip to the Direction</Link>
      <div className="sheet">
        <header className="top">
          <h1 className="name"><Link href="/">Forge cockpit</Link></h1>
          <dl className="block">
            <div className="cell">
              <dt>Last read</dt>
              <dd className="read">
                <span>{`${state.lastRead ? clock(state.lastRead) : 'not yet'} · every 5 s`}</span>
                <Button className="button" onPress={() => { void cockpit.refresh(); }}>Refresh</Button>
              </dd>
            </div>
          </dl>
        </header>
        <div className="body">
          <Directions cockpit={cockpit} state={state} />
          <main id="main" className="main" tabIndex={-1}>
            <div role="status">{state.connectionError ? <Failure>{state.connectionError}</Failure> : null}</div>
            <Selected cockpit={cockpit} state={state} />
          </main>
        </div>
      </div>
    </>
  );
}

function Directions({ cockpit, state }: { cockpit: Cockpit; state: CockpitState }) {
  return (
    <aside className="directions" aria-labelledby="directions-title">
      <PartTitle id="directions-title" level={2} count={state.directions.length ? String(state.directions.length) : undefined}>Directions</PartTitle>
      <CreateDirection cockpit={cockpit} state={state} />
      {state.list !== 'read' ? (
        <p className="empty">{state.list === 'failed' ? 'Directions could not be read.' : 'Loading Directions…'}</p>
      ) : (
        <ListBox
          aria-labelledby="directions-title"
          className="direction-list"
          items={state.directions.map(direction => ({ ...direction, id: direction.name }))}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={state.active ? [state.active] : []}
          onSelectionChange={keys => {
            const [name] = keys === 'all' ? [] : [...keys];
            if (typeof name === 'string') void cockpit.selectDirection(name);
          }}
          renderEmptyState={() => <p className="empty">No Directions yet.</p>}
        >
          {direction => (
            <ListBoxItem id={direction.name} textValue={direction.name} className="direction-option">
              <span className="direction-name">{direction.name}</span>
              <span className="direction-meta"><Mark>{direction.workerId ? '●' : '○'}</Mark>{direction.workerId ? 'Worker selected' : 'No Worker selected'}</span>
            </ListBoxItem>
          )}
        </ListBox>
      )}
    </aside>
  );
}

function CreateDirection({ cockpit, state }: { cockpit: Cockpit; state: CockpitState }) {
  return (
    <DialogTrigger isOpen={state.createOpen} onOpenChange={open => { if (open) cockpit.openCreate(); else cockpit.closeCreate(); }}>
      <Button className="button new-direction">New Direction</Button>
      <ModalOverlay className="overlay">
        <Modal className="modal">
          <Dialog className="dialog">
            <Heading slot="title" className="part-title">New Direction</Heading>
            <Form onSubmit={event => { event.preventDefault(); void cockpit.createDirection(); }}>
              <TextField className="field" value={state.createName} onChange={value => cockpit.setCreateName(value)} isRequired autoFocus>
                <Label>Name</Label>
                <Input className="input name-input" placeholder="parser-improvements" autoComplete="off" spellCheck="false" />
                <Text slot="description" className="note">The Direction’s folder: up to 80 letters, numbers, dots, dashes or underscores, starting with a letter or number.</Text>
              </TextField>
              <TextField className="field" value={state.createGoal} onChange={value => cockpit.setCreateGoal(value)} isRequired>
                <Label>Goal</Label>
                <TextArea className="input authored" rows={6} placeholder="What should this Worker pursue?" />
              </TextField>
              <div role="status">{state.createError ? <Failure>{state.createError}</Failure> : null}</div>
              <p className="note">Creating a Direction starts no Worker. Send STEER to start one.</p>
              <div className="actions">
                <Button slot="close" className="button">Cancel</Button>
                <Button type="submit" className="button button-primary" isPending={state.creating}>{state.creating ? 'Creating…' : 'Create Direction'}</Button>
              </div>
            </Form>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}

function Selected({ cockpit, state }: { cockpit: Cockpit; state: CockpitState }) {
  const title = state.active ?? (state.list === 'loading' ? 'Reading Directions…' : 'No Direction selected');
  return (
    <>
      <section className="direction-head" aria-labelledby="view-title">
        <h2 id="view-title">{title}</h2>
        {state.detail ? <Binding detail={state.detail} /> : null}
      </section>
      {!state.active ? (
        state.list === 'read' && !state.directions.length
          ? <p className="prompt">Create a Direction with a goal, then send STEER to start its Worker.</p> : null
      ) : !state.detail ? <Empty title="Loading Direction…" /> : (
        <>
          <Tabs className="views" selectedKey={state.tab} onSelectionChange={key => { if (isView(key)) void cockpit.selectView(key); }}>
            <TabList aria-label="Direction views" className="switch">
              <Tab id="overview" className="switch-option">Overview</Tab>
              <Tab id="checklist" className="switch-option">Checklist</Tab>
              <Tab id="diff" className="switch-option">Workspace diff</Tab>
            </TabList>
            <TabPanel id="overview" className="view">{state.detailTab === 'overview' ? <Overview cockpit={cockpit} state={state} detail={state.detail} /> : <Empty title="Loading Overview…" />}</TabPanel>
            <TabPanel id="checklist" className="view">{state.detailTab === 'checklist' ? <Checklist detail={state.detail} /> : <Empty title="Loading Checklist…" />}</TabPanel>
            <TabPanel id="diff" className="view">{state.detailTab === 'diff' ? <WorkspaceDiff cockpit={cockpit} state={state} /> : <Empty title="Loading Workspace diff…" />}</TabPanel>
          </Tabs>
          <Steer cockpit={cockpit} state={state} detail={state.detail} />
        </>
      )}
    </>
  );
}

/** The Direction's binding, in every view: where it is stored and its Worker. */
function Binding({ detail }: { detail: Detail }) {
  const worker = workerState(detail);
  return (
    <dl className="binding">
      <div className="cell"><dt>Folder</dt><dd>{detail.folder}</dd></div>
      <div className="cell">
        <dt>Worker</dt>
        <dd>
          {detail.workerId ? <span className="worker-id" title={detail.workerId}>{detail.workerId}</span> : null}
          <span role="status" className="worker-state"><StateLine state={worker} /></span>
        </dd>
      </div>
      <div className="cell"><dt>Container</dt><dd>{detail.container || 'Configured by the host'}</dd></div>
      <div className="cell"><dt>Workspace</dt><dd>{detail.workspace}</dd></div>
    </dl>
  );
}

function Overview({ cockpit, state, detail }: { cockpit: Cockpit; state: CockpitState; detail: Detail }) {
  const accounts = state.progress;
  return (
    <div className="overview">
      <section className="part" aria-labelledby="goal-title">
        <PartTitle id="goal-title">Goal</PartTitle>
        {detail.goalError ? <Failure>{`Goal unavailable: ${detail.goalError}`}</Failure>
          : detail.goal ? <div className="authored goal">{detail.goal}</div>
            : <p className="note">No goal text recorded.</p>}
        {detail.goalTruncated ? <p className="note">Goal preview truncated. The complete goal remains in goal.md.</p> : null}
      </section>
      <section className="part" aria-labelledby="progress-title">
        <PartTitle id="progress-title" count={accounts.length ? `${accounts.length} loaded` : undefined}>PROGRESS</PartTitle>
        {accounts.length ? (
          <>
            <div className="progress-list" role="region" aria-label="PROGRESS, newest first" tabIndex={0}>
              {accounts.map(account => <Account key={account.seq} account={account} />)}
            </div>
            <div className="progress-history">
              {state.historyDone ? <p className="note">First stored account reached.</p> : (
                <>
                  <Button className="button" isPending={state.loadingOlder} onPress={() => { void cockpit.loadOlderProgress(); }}>
                    {state.loadingOlder ? 'Loading…' : 'Load earlier PROGRESS'}
                  </Button>
                  {detail.progressWindow?.latest ? <p className="note">{`The latest ${detail.progressWindow.limit} stored accounts load first.`}</p> : null}
                </>
              )}
            </div>
          </>
        ) : <Empty title="No PROGRESS recorded yet">The Worker can write an account here when it has something useful to share.</Empty>}
      </section>
    </div>
  );
}

function Account({ account }: { account: Progress }) {
  const author = account.workerId || 'Worker';
  return (
    <article className="account">
      <p className="account-meta">
        <span className="author" title={author}>{author}</span>
        <time dateTime={account.createdAt ?? undefined} title={account.createdAt ?? undefined}>{time(account.createdAt)}</time>
        {account.inReplyTo ? <span>{`In reply to ${account.inReplyTo}`}</span> : null}
      </p>
      <p className="authored account-body">{account.body ?? ''}</p>
      {account.bodyTruncated ? <p className="note">Account preview truncated. Read the complete stored account through the Forge CLI.</p> : null}
    </article>
  );
}

/** A stored file: its path opens its preserved contents. */
function File({ file, content, level, authored }: { file: StoredFile; content: { text?: string; binary?: boolean }; level: 4 | 5; authored: boolean }) {
  return (
    <Disclosure className="file">
      {({ isExpanded }) => (
        <>
          <Heading level={level} className="file-heading">
            <Button slot="trigger" className="file-trigger"><Mark>{isExpanded ? '▾' : '▸'}</Mark>{file.path}</Button>
          </Heading>
          <DisclosurePanel className="file-panel">
            {file.skipped ? <p className="note">{`Skipped: ${typeof file.skipped === 'string' ? file.skipped : 'unsupported file'}`}</p>
              : content.binary ? <p className="note">Binary content is retained in the workspace.</p>
                : <pre className={authored ? 'authored' : 'code'} tabIndex={0}>{content.text}</pre>}
            {file.truncated ? <p className="note">This preview is truncated.</p> : null}
          </DisclosurePanel>
        </>
      )}
    </Disclosure>
  );
}

function Checklist({ detail }: { detail: Detail }) {
  const files = detail.checklist || [];
  const error = detail.checklistError;
  return (
    <section className="part" aria-labelledby="checklist-title">
      <PartTitle id="checklist-title" count={!error && files.length ? `${files.length} ${files.length === 1 ? 'file' : 'files'}` : undefined}>Checklist</PartTitle>
      {error ? <Failure>{`Checklist unavailable: ${error}`}</Failure> : null}
      {files.length ? <div className="files">{files.map(file => <File key={file.path} file={file} content={decodeFile(file)} level={4} authored />)}</div>
        : !error ? <Empty title="No checklist files yet">Checks live in this Direction’s checklist folder. Add ordinary files through the workspace.</Empty> : null}
      {detail.checklistTruncated ? <p className="note">The checklist preview is truncated. Inspect the Direction folder for all files and complete contents.</p> : null}
    </section>
  );
}

function WorkspaceDiff({ cockpit, state }: { cockpit: Cockpit; state: CockpitState }) {
  const input = useRef<HTMLInputElement>(null);
  const diff = state.diff;
  const reference = diff?.comparison?.reference || state.diffBase;
  const uncommitted = diff?.comparison?.kind === 'uncommitted' || (!diff?.comparison && reference === 'HEAD');
  return (
    <section className="part" aria-labelledby="diff-title">
      <PartTitle id="diff-title" count="shared workspace">{uncommitted ? 'Uncommitted changes' : `Changes from ${reference}`}</PartTitle>
      <Form className="diff-controls" onSubmit={event => { event.preventDefault(); if (!cockpit.compare()) input.current?.focus(); }}>
        <TextField className="field" value={state.diffDraft} onChange={value => cockpit.setDiffDraft(value)}
          onFocusChange={focused => cockpit.setDiffEditing(focused)} isRequired>
          <Label>Compare against Git reference</Label>
          <div className="control-row">
            <Input ref={input} className="input reference" placeholder="HEAD, a branch, tag or commit" autoComplete="off" spellCheck="false" />
            <Button type="submit" className="button">Compare</Button>
          </div>
          <Text slot="description" className="note">HEAD shows uncommitted changes. Choose an earlier reference to include committed work.</Text>
        </TextField>
      </Form>
      {!diff ? <Empty title="Reading the workspace diff…" /> : !diff.available ? (
        <Failure>{`Git diff unavailable: ${diff.error || 'This workspace does not have an available Git comparison.'}`}</Failure>
      ) : (
        <>
          <dl className="facts">
            <div>
              <dt>Compared with</dt>
              <dd>
                <span>{reference}</span>
                {diff.comparison?.commit ? <span className="commit" title={diff.comparison.commit}>{diff.comparison.commit.slice(0, 12)}</span> : null}
                {diff.comparison?.unborn ? <span>No initial commit</span> : null}
              </dd>
            </div>
            {diff.scope ? <div><dt>Scope</dt><dd>{diff.scope}</dd></div> : null}
            {diff.status ? <div><dt>Status</dt><dd><pre className="status" tabIndex={0}>{diff.status}</pre></dd></div> : null}
          </dl>
          {diff.patch ? (
            <pre className="patch" tabIndex={0} aria-label="Patch">
              {diff.patch.replace(/\n$/, '').split('\n').map((line, index) => <span key={index} className={`line line-${patchLine(line)}`}>{line || '​'}</span>)}
            </pre>
          ) : null}
          {diff.truncated ? <p className="note">The diff preview is truncated. Inspect the workspace for the complete patch.</p> : null}
          {diff.untracked?.length ? (
            <>
              <h4 className="label untracked-title">{`Untracked files · ${diff.untracked.length}`}</h4>
              <div className="files">{diff.untracked.map(file => <File key={file.path} file={file} level={5} authored={false}
                content={{ binary: file.binary, text: file.content ?? 'Content preview unavailable.' }} />)}</div>
            </>
          ) : null}
          {!diff.patch && !diff.untracked?.length ? (
            <Empty title={uncommitted ? 'No uncommitted changes relative to HEAD' : 'No differences from the selected reference'}>
              {diff.status ? 'See the workspace status above.' : `Comparison: ${reference}`}
            </Empty>
          ) : null}
        </>
      )}
    </section>
  );
}

function Steer({ cockpit, state, detail }: { cockpit: Cockpit; state: CockpitState; detail: Detail }) {
  const text = useRef<HTMLTextAreaElement>(null);
  const mode = workerModeOf(state);
  const help = mode === 'existing' ? 'Delivered directly to the existing Worker. Authored results appear in PROGRESS.'
    : `A fresh Worker receives your message and this Direction’s goal and checklist pointers.${detail.workerId ? ' The existing Worker is not stopped.' : ''}`;
  return (
    <section className="part steer" aria-labelledby="steer-title">
      <PartTitle id="steer-title" count={`to ${state.active}`}>Send STEER</PartTitle>
      <Form onSubmit={async event => {
        event.preventDefault();
        if (await cockpit.sendSteer() === 'empty') text.current?.focus();
      }}>
        <TextField className="field" value={draftOf(state).text} onChange={value => cockpit.setDraftText(value)} isRequired aria-describedby="steer-help">
          <Label className="sr-only">STEER message for the Worker</Label>
          <TextArea ref={text} className="input authored" rows={4} placeholder="Supply context, answer a question, request information or continue the work…" />
        </TextField>
        <div className="composer">
          <RadioGroup className="worker-choice" aria-label="Worker" orientation="horizontal" value={mode}
            onChange={value => cockpit.setWorkerMode(value === 'fresh' ? 'fresh' : 'existing')}>
            <Radio value="existing" className="radio" isDisabled={!detail.workerId}>
              <span className="indicator" aria-hidden="true" />{detail.workerId ? 'Existing Worker' : 'Existing Worker · none selected'}
            </Radio>
            <Radio value="fresh" className="radio"><span className="indicator" aria-hidden="true" />Fresh Worker</Radio>
          </RadioGroup>
          <Button type="submit" className="button button-primary" isPending={state.sending}>{state.sending ? 'Sending…' : 'Send STEER'}</Button>
        </div>
        <p id="steer-help" className="note">{help}</p>
        <div role="status">{state.steerResult ? (
          state.steerResult.error ? <Failure>{state.steerResult.text}</Failure> : <p className="notice">{state.steerResult.text}</p>
        ) : null}</div>
      </Form>
    </section>
  );
}

