# HCL standards

The kit Stop hook runs `fmt` and `tflint` for you. Override the detected tool with `/kit:hcl-tool tofu` or `/kit:hcl-tool terraform`.
The project's pinned tool wins over the detected one.

## Files and layout

- Use `.tf` by default. Use `.tofu` or `.tofu.json` only for a file that needs OpenTofu-only features.
- Keep `.tfvars` for variable values only, never for resource or block definitions.
- Split configuration by role: `main.tf`, `variables.tf`, `outputs.tf`, `versions.tf` and `providers.tf`. Group a large `main.tf` into domain files such as `network.tf`.
- Never commit `.terraform/`, `*.tfstate` or `*.tfstate.backup`.
- Commit `.terraform.lock.hcl`, and never edit it by hand. `init` and `providers lock` manage it.
- Use `#` for comments, never `//` or `/* */`.

## Naming

- Use `snake_case` for every object name.
- Never repeat the resource type in the name.

```hcl
# Good:
resource "aws_instance" "web" {}

# Bad:
resource "aws_instance" "web_instance" {}
```

## Variables and outputs

- Give every `variable` a `type` and a `description`. Omit `default` to make a variable required.
- Avoid the bare `any` type. Use `object({ ... })` so callers get type checking.
- Add a `validation` block only for restrictive rules, with an actionable `error_message`.
- Mark a secret variable or output with `sensitive = true`. The value is still stored in state.
- Expose a variable only when the value changes between deployments.
- Give every `output` a `description`. Order its arguments `description`, `value`, `sensitive`.

## Resources

- Use `for_each` for collections. Use `count = var.enabled ? 1 : 0` only for conditional creation.
- Use `dynamic` blocks only when you can't write the repeated nested blocks statically.
- Order arguments in a resource:
  1. `for_each` or `count`
  2. Non-block arguments
  3. Nested blocks
  4. `lifecycle`
  5. `depends_on`

```hcl
resource "aws_instance" "web" {
  for_each = toset(var.web_roles)

  ami           = data.aws_ami.web.id
  instance_type = "t3.micro"

  tags = {
    Name = "web_${each.key}"
  }
}
```

## Version pinning

- Set `required_version` with a pessimistic `~>` constraint.
- Pin every provider in `required_providers` with a `source` and a `~>` version.

```hcl
terraform {
  required_version = "~> 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.34"
    }
  }
}
```

## Anti-patterns

- Never hardcode secrets or credentials. Read them from a secrets manager or provider environment variables.
- Never declare `provider` blocks in a reusable module. Pass providers in from the root module.
- Avoid `terraform_remote_state` when a data source reads the same value.

## Tooling

- `fmt` formats configuration. The hook always runs it.
- `validate` checks configuration. The hook never runs it, because it depends on the providers captured at the last `init`. Run it yourself, or in CI, after `init`.
- `tflint` lints against provider rules. The hook runs it only when `tflint` is installed and a `.tflint.hcl` exists.
