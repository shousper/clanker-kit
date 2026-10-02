terraform {
  required_version = ">= 1.6.0"
}

resource "terraform_data" "release" {
  input = var.release_name
}
