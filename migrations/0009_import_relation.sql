-- Importeret materiale har ingen "tilknytning" (den gælder personer, der selv deler noget).
UPDATE submissions SET relation = '' WHERE source_url != '' AND relation = 'andet';
