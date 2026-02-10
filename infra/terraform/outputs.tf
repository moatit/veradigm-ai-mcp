# =============================================================================
# Outputs
# =============================================================================

output "ec2_instance_id" {
  description = "EC2 instance ID (add to GitHub secrets as EC2_INSTANCE_ID)"
  value       = aws_instance.app.id
}

output "ec2_public_ip" {
  description = "EC2 public IP — access your apps here"
  value       = aws_eip.app.public_ip
}

output "ecr_repository_urls" {
  description = "ECR repository URLs"
  value = {
    for name, repo in aws_ecr_repository.repos : name => repo.repository_url
  }
}

output "access_urls" {
  description = "Direct access URLs"
  value = {
    fhir_mcp     = "http://${aws_eip.app.public_ip}:3000"
    unity_mcp    = "http://${aws_eip.app.public_ip}:3001"
    admin_portal = "http://${aws_eip.app.public_ip}:5001"
  }
}
