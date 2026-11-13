export default {
  sent: "Sent {{size}}k characters of context.",
  answeredBy: "Answer by {{model}}.",
  declined: "Claude declined to answer this one.",
  noSecrets: "kubedeck never sends Secrets to Claude.",
  explain: "Explain with Claude",
  thinking: "Thinking…",
  again: "Explain again",
  sendsPod: "Sends this pod's manifest (secret values removed), events and recent logs to the Anthropic API.",
  sendsObject: "Sends this object's manifest (secret values removed) and events to the Anthropic API.",
  production: "This is a production cluster.",
  removeKey: "Remove key",
  intro: "Claude reads what kubectl describe and logs would show you, and suggests the likely cause and a fix.",
  key: {
    title: "Connect Claude",
    hint: "Paste an Anthropic API key. It is stored in your system keychain, never in a file, and only used when you click Explain. You can also set <code>ANTHROPIC_API_KEY</code>.",
    save: "Save key",
  },
};
