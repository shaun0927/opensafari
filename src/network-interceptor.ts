export interface InterceptRule {
  id: string;
  urlPattern: string;
  action: 'block' | 'mock';
  mockResponse?: {
    status: number;
    headers: Record<string, string>;
    body: string;
  };
}

export interface InterceptorClient {
  evaluate<T = unknown>(expression: string): Promise<T>;
}

let ruleIdCounter = 0;

export function globToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      regex += '.*';
      i += 2;
      if (pattern[i] === '/') i++;
    } else if (ch === '*') {
      regex += '[^/]*';
      i++;
    } else if (ch === '?') {
      regex += '[^/]';
      i++;
    } else if (ch === '.') {
      regex += '\\.';
      i++;
    } else if ('^$+{}[]|()\\'.includes(ch)) {
      regex += '\\' + ch;
      i++;
    } else {
      regex += ch;
      i++;
    }
  }
  return new RegExp('^' + regex + '$');
}

export function matchUrl(url: string, pattern: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return url.includes(pattern);
  }
  return globToRegex(pattern).test(url);
}

export class NetworkInterceptor {
  private rules: Map<string, InterceptRule> = new Map();
  private _enabled = false;
  private _offline = false;

  get enabled(): boolean { return this._enabled; }
  get offline(): boolean { return this._offline; }

  addRule(rule: Omit<InterceptRule, 'id'>): InterceptRule {
    const id = 'rule_' + (++ruleIdCounter);
    const full: InterceptRule = { id, ...rule };
    this.rules.set(id, full);
    return full;
  }

  removeRule(id: string): boolean { return this.rules.delete(id); }
  listRules(): InterceptRule[] { return [...this.rules.values()]; }
  clearRules(): void { this.rules.clear(); }

  findMatchingRule(url: string): InterceptRule | undefined {
    for (const rule of this.rules.values()) {
      if (matchUrl(url, rule.urlPattern)) return rule;
    }
    return undefined;
  }

  async enable(client: InterceptorClient): Promise<void> {
    this._enabled = true;
    await this.inject(client);
  }

  async disable(client: InterceptorClient): Promise<void> {
    this._enabled = false;
    this._offline = false;
    this.rules.clear();
    await client.evaluate('(function(){if(window.__osOriginalFetch){window.fetch=window.__osOriginalFetch;delete window.__osOriginalFetch}if(window.__osOriginalXHROpen){XMLHttpRequest.prototype.open=window.__osOriginalXHROpen;delete window.__osOriginalXHROpen}delete window.__osInterceptRules;delete window.__osOfflineMode})()');
  }

  async setOffline(enabled: boolean, client: InterceptorClient): Promise<void> {
    this._offline = enabled;
    if (enabled && !this._enabled) this._enabled = true;
    await this.inject(client);
  }

  async syncRules(client: InterceptorClient): Promise<void> {
    if (!this._enabled) return;
    await this.inject(client);
  }

  private async inject(client: InterceptorClient): Promise<void> {
    const rulesJson = JSON.stringify(this.listRules());
    const offlineFlag = this._offline ? 'true' : 'false';
    const script = '(function(){if(!window.__osOriginalFetch){window.__osOriginalFetch=window.fetch.bind(window)}if(!window.__osOriginalXHROpen){window.__osOriginalXHROpen=XMLHttpRequest.prototype.open}window.__osInterceptRules=' + rulesJson + ';window.__osOfflineMode=' + offlineFlag + ';function m(u,p){if(p.indexOf("*")===-1&&p.indexOf("?")===-1)return u.indexOf(p)!==-1;var r="";for(var i=0;i<p.length;i++){var c=p[i];if(c==="*"&&p[i+1]==="*"){r+=".*";i++;if(p[i+1]==="/")i++}else if(c==="*")r+="[^/]*";else if(c==="?")r+="[^/]";else if(c===".")r+="\\\\.";else if("^$+{}[]|()\\\\".indexOf(c)!==-1)r+="\\\\"+c;else r+=c}return new RegExp("^"+r+"$").test(u)}function f(u){var rules=window.__osInterceptRules||[];for(var i=0;i<rules.length;i++)if(m(u,rules[i].urlPattern))return rules[i];return null}window.fetch=function(input,init){var url=(typeof input==="string")?input:(input&&input.url?input.url:"");if(window.__osOfflineMode)return Promise.reject(new TypeError("Failed to fetch"));var rule=f(url);if(rule){if(rule.action==="block")return Promise.reject(new TypeError("Request blocked by OpenSafari"));if(rule.action==="mock"&&rule.mockResponse)return Promise.resolve(new Response(rule.mockResponse.body||"",{status:rule.mockResponse.status||200,headers:new Headers(rule.mockResponse.headers||{})}))}return window.__osOriginalFetch(input,init)};XMLHttpRequest.prototype.open=function(method,url){this.__osUrl=url;this.__osBlocked=false;if(window.__osOfflineMode){this.__osBlocked=true}else{var rule=f(String(url));if(rule){this.__osMatchedRule=rule;if(rule.action==="block")this.__osBlocked=true}}return window.__osOriginalXHROpen.apply(this,arguments)};var origSend=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.send=function(body){if(this.__osBlocked){Object.defineProperty(this,"status",{get:function(){return 0}});Object.defineProperty(this,"readyState",{get:function(){return 4}});if(typeof this.onerror==="function")this.onerror(new Error("Blocked"));this.dispatchEvent(new Event("error"));return}if(this.__osMatchedRule&&this.__osMatchedRule.action==="mock"){var mk=this.__osMatchedRule.mockResponse||{};var s=this;Object.defineProperty(s,"status",{get:function(){return mk.status||200}});Object.defineProperty(s,"responseText",{get:function(){return mk.body||""}});Object.defineProperty(s,"readyState",{get:function(){return 4}});setTimeout(function(){if(typeof s.onload==="function")s.onload(new Event("load"));s.dispatchEvent(new Event("load"))},0);return}return origSend.apply(this,arguments)}})()';
    await client.evaluate(script);
  }
}
