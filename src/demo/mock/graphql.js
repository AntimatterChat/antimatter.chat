// A small GraphQL executor for the demo's Playbooks queries: it parses a query (fields, aliases, arguments,
// variables, fragments, @include/@skip) and resolves it against plain objects, so each query gets exactly the fields,
// aliases and __typename it asks for. Objects made with DemoPlugins.gqlView(type, restObject, extra) read their
// camelCase fields from the REST object's snake_case keys (teamID reads team_id, invitedUserIDs reads
// invited_user_ids), with extra holding computed fields.
(function () {
    'use strict';

    function tokenize(src) {
        var tokens = [];
        var i = 0;
        var re = /[\s,\ufeff]+|#[^\n]*|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|\.\.\.|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[_A-Za-z][_0-9A-Za-z]*|[!$():=@[\]{}|&]/y;
        while (i < src.length) {
            re.lastIndex = i;
            var m = re.exec(src);
            if (!m) {
                throw new Error('GraphQL syntax error at ' + i);
            }
            i = re.lastIndex;
            var t = m[0];
            if (/^[\s,\ufeff]/.test(t) || t[0] === '#') {
                continue;
            }
            tokens.push(t);
        }
        return tokens;
    }

    function Parser(src) {
        this.t = tokenize(src);
        this.i = 0;
    }
    Parser.prototype.peek = function () {
        return this.t[this.i];
    };
    Parser.prototype.next = function () {
        return this.t[this.i++];
    };
    Parser.prototype.expect = function (v) {
        var t = this.next();
        if (t !== v) {
            throw new Error('GraphQL: expected ' + v + ', got ' + t);
        }
        return t;
    };
    Parser.prototype.document = function () {
        var doc = {operations: [], fragments: {}};
        while (this.i < this.t.length) {
            var t = this.peek();
            if (t === '{') {
                doc.operations.push({type: 'query', name: '', vars: {}, selections: this.selectionSet()});
            } else if (t === 'fragment') {
                this.next();
                var name = this.next();
                this.expect('on');
                this.next();
                this.directives();
                doc.fragments[name] = this.selectionSet();
            } else {
                var type = this.next();
                var opName = this.peek() !== '(' && this.peek() !== '{' && this.peek() !== '@' ? this.next() : '';
                var vars = this.peek() === '(' ? this.variableDefinitions() : {};
                this.directives();
                doc.operations.push({type: type, name: opName, vars: vars, selections: this.selectionSet()});
            }
        }
        return doc;
    };
    Parser.prototype.variableDefinitions = function () {
        var defs = {};
        this.expect('(');
        while (this.peek() !== ')') {
            this.expect('$');
            var name = this.next();
            this.expect(':');
            this.type();
            defs[name] = this.peek() === '=' ? (this.next(), this.value()) : undefined;
            this.directives();
        }
        this.expect(')');
        return defs;
    };
    Parser.prototype.type = function () {
        if (this.peek() === '[') {
            this.next();
            this.type();
            this.expect(']');
        } else {
            this.next();
        }
        if (this.peek() === '!') {
            this.next();
        }
    };
    Parser.prototype.directives = function () {
        var out = [];
        while (this.peek() === '@') {
            this.next();
            var name = this.next();
            out.push({name: name, args: this.peek() === '(' ? this.args() : {}});
        }
        return out;
    };
    Parser.prototype.args = function () {
        var args = {};
        this.expect('(');
        while (this.peek() !== ')') {
            var name = this.next();
            this.expect(':');
            args[name] = this.value();
        }
        this.expect(')');
        return args;
    };
    Parser.prototype.value = function () {
        var t = this.next();
        if (t === '$') {
            return {$var: this.next()};
        }
        if (t === '[') {
            var list = [];
            while (this.peek() !== ']') {
                list.push(this.value());
            }
            this.next();
            return {$list: list};
        }
        if (t === '{') {
            var obj = {};
            while (this.peek() !== '}') {
                var k = this.next();
                this.expect(':');
                obj[k] = this.value();
            }
            this.next();
            return {$obj: obj};
        }
        if (t[0] === '"') {
            return t.slice(0, 3) === '"""' ? t.slice(3, -3) : JSON.parse(t);
        }
        if (/^-?\d/.test(t)) {
            return Number(t);
        }
        if (t === 'true' || t === 'false') {
            return t === 'true';
        }
        if (t === 'null') {
            return null;
        }
        return t; // An enum value.
    };
    Parser.prototype.selectionSet = function () {
        var out = [];
        this.expect('{');
        while (this.peek() !== '}') {
            if (this.peek() === '...') {
                this.next();
                if (this.peek() === 'on' || this.peek() === '{' || this.peek() === '@') {
                    if (this.peek() === 'on') {
                        this.next();
                        this.next();
                    }
                    var dirs = this.directives();
                    out.push({inline: this.selectionSet(), directives: dirs});
                } else {
                    var frag = this.next();
                    out.push({spread: frag, directives: this.directives()});
                }
                continue;
            }
            var name = this.next();
            var alias = name;
            if (this.peek() === ':') {
                this.next();
                name = this.next();
            }
            var field = {alias: alias, name: name, args: this.peek() === '(' ? this.args() : {}};
            field.directives = this.directives();
            if (this.peek() === '{') {
                field.selections = this.selectionSet();
            }
            out.push(field);
        }
        this.expect('}');
        return out;
    };

    function resolveValue(v, vars) {
        if (v && typeof v === 'object') {
            if ('$var' in v) {
                return vars[v.$var];
            }
            if ('$list' in v) {
                return v.$list.map(function (x) {
                    return resolveValue(x, vars);
                });
            }
            if ('$obj' in v) {
                var o = {};
                Object.keys(v.$obj).forEach(function (k) {
                    o[k] = resolveValue(v.$obj[k], vars);
                });
                return o;
            }
        }
        return v;
    }

    function included(directives, vars) {
        return (directives || []).every(function (d) {
            var cond = resolveValue(d.args.if, vars);
            if (d.name === 'include') {
                return Boolean(cond);
            }
            if (d.name === 'skip') {
                return !cond;
            }
            return true;
        });
    }

    // fields flattens fragments and inline fragments into the list of fields to answer.
    function fields(selections, doc, vars) {
        var out = [];
        selections.forEach(function (s) {
            if (!included(s.directives, vars)) {
                return;
            }
            if (s.spread) {
                out = out.concat(fields(doc.fragments[s.spread] || [], doc, vars));
            } else if (s.inline) {
                out = out.concat(fields(s.inline, doc, vars));
            } else {
                out.push(s);
            }
        });
        return out;
    }

    function snake(name) {
        return name.replace(/IDs$/, 'Ids').replace(/ID$/, 'Id').replace(/URLs$/, 'Urls').replace(/URL$/, 'Url')
            .replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    }

    function readField(value, name) {
        if (value.__obj) {
            if (name in value.__extra) {
                var x = value.__extra[name];
                return typeof x === 'function' ? x() : x;
            }
            var o = value.__obj;
            if (o[name] !== undefined) {
                return o[name];
            }
            var s = snake(name);
            return o[s] !== undefined ? o[s] : null;
        }
        return value[name] !== undefined ? value[name] : null;
    }

    function complete(value, selections, doc, vars) {
        if (value === null || value === undefined) {
            return null;
        }
        if (Array.isArray(value)) {
            return value.map(function (v) {
                return complete(v, selections, doc, vars);
            });
        }
        if (!selections) {
            return value && value.__obj ? value.__obj : value;
        }
        var out = {};
        fields(selections, doc, vars).forEach(function (f) {
            if (f.name === '__typename') {
                out[f.alias] = value.__typename || null;
                return;
            }
            out[f.alias] = complete(readField(value, f.name), f.selections, doc, vars);
        });
        return out;
    }

    window.DemoGraphQL = {
        execute: function (query, variables, root, operationName) {
            var doc = new Parser(query).document();
            var op = doc.operations.find(function (o) {
                return !operationName || o.name === operationName;
            }) || doc.operations[0];
            var vars = Object.assign({}, variables || {});
            Object.keys(op.vars).forEach(function (k) {
                if (vars[k] === undefined && op.vars[k] !== undefined) {
                    vars[k] = resolveValue(op.vars[k], vars);
                }
            });
            var data = {};
            fields(op.selections, doc, vars).forEach(function (f) {
                if (f.name === '__typename') {
                    data[f.alias] = op.type === 'mutation' ? 'Mutation' : 'Query';
                    return;
                }
                var args = {};
                Object.keys(f.args).forEach(function (k) {
                    args[k] = resolveValue(f.args[k], vars);
                });
                var fn = root[f.name];
                data[f.alias] = complete(fn ? fn(args) : null, f.selections, doc, vars);
            });
            return data;
        },
        snake: snake,
    };
}());
