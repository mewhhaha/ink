/** The panels a large world stresses: outliner, inspector, timeline, views. */
import {
  Brand,
  BuildStatus,
  Console,
  HistoryButtons,
  InkApp,
  Inspector,
  Outliner,
  Pane,
  Panel,
  PlayControls,
  Spacer,
  Split,
  Timeline,
  TopBar,
  Viewport,
  Workspace,
} from "@ink/react";

export function App() {
  return (
    <InkApp project="scripts/stress" title="Ink Stress">
      <TopBar>
        <Brand subtitle="stress" />
        <HistoryButtons />
        <Spacer />
        <PlayControls />
        <Spacer />
        <BuildStatus />
      </TopBar>
      <Workspace>
        <Split id="columns">
          <Pane size={260} min={180}>
            <Panel title="Scene">
              <Outliner />
            </Panel>
          </Pane>
          <Pane>
            <Split id="center" direction="column">
              <Pane>
                <Viewport id="game" view="game" label="Game" />
              </Pane>
              <Pane size={210} min={80}>
                <Panel
                  id="bottom"
                  tabs={[
                    { id: "output", label: "Output", content: <Console /> },
                    {
                      id: "timeline",
                      label: "Timeline",
                      content: <Timeline />,
                    },
                  ]}
                />
              </Pane>
            </Split>
          </Pane>
          <Pane size={320} min={240}>
            <Panel title="Inspector">
              <Inspector />
            </Panel>
          </Pane>
        </Split>
      </Workspace>
    </InkApp>
  );
}
