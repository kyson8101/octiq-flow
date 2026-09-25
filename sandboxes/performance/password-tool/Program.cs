using System.Text.Json;

// Use the application's actual password format with a new fixture-only salt.
var input = JsonDocument.Parse(Console.In.ReadToEnd()).RootElement;
Console.Write(new PPLM.PKey().Encrypt(input.GetProperty("password").GetString()!, input.GetProperty("salt").GetString()!));
